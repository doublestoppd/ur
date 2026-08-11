/*
 * normalizeEncounter.js - turns mapped source rows into the canonical encounter
 * records every downstream module consumes (spec 6, 9.1, 11.2).
 *
 * This is the only place raw cells are interpreted. Once a row leaves here it
 * carries parsed wall-clock datetimes, a service classification, a payer
 * category, a disposition, and an explicit statement of whether it may take
 * part in metrics - plus a diagnostic for every judgement that was made.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var parsers = UR.parsers;
  var reader = UR.spreadsheetReader;
  var cfgSchema = UR.configSchema;

  /* Signature used to detect exact duplicate rows across files and sheets. */
  function rowSignature(e) {
    return [
      e.account, e.mrn, e.serviceRaw,
      e.admitDT ? e.admitDT.getTime() : '',
      e.dischargeDT ? e.dischargeDT.getTime() : '',
      e.insuranceRaw, e.dischargeCodeRaw, e.admissionSourceRaw, e.name
    ].join('');
  }

  /* Content signature ignoring the account number, for conflict detection. */
  function contentSignature(e) {
    return [
      e.mrn, e.serviceRaw,
      e.admitDT ? e.admitDT.getTime() : '',
      e.dischargeDT ? e.dischargeDT.getTime() : '',
      e.insuranceRaw, e.dischargeCodeRaw
    ].join('');
  }

  function normalizeOne(row, ctx) {
    var mapping = ctx.mapping;
    var config = ctx.config;
    var diag = ctx.diagnostics;

    var e = {
      rowId: ctx.nextRowId(),
      sourceFile: ctx.sourceFile,
      sourceSheet: ctx.sourceSheet,
      sourceRowNumber: row.sourceRowNumber,

      account: '', accountSynthetic: false,
      mrn: '', name: '',
      serviceRaw: '', serviceClass: UR.SERVICE.UNKNOWN, serviceLabel: '',
      admitDT: null, dischargeDT: null,
      admitTimeAssumed: false, dischargeTimeAssumed: false,
      isOpen: false,
      durationHours: null, durationDays: null, midnights: null, durationClamped: false,
      insuranceRaw: '', payerCategory: UR.PAYER_CATEGORY.UNKNOWN, payerLabel: '',
      dischargeCodeRaw: '', dischargeCodeLabel: '', dispositionCategory: '', isDeath: false,
      transitionTo: null, transitionFrom: null,
      admissionSourceRaw: '', admissionSourceLabel: '', admissionSourceCategory: '',

      included: false,      /* service maps to IP / OS / SB */
      metricEligible: false,/* may contribute to metrics */
      excludedReason: '',
      episodeId: null,
      linkPrev: null, linkNext: null,
      reviewFlags: [],
      flags: []
    };

    function cell(key) { return reader.cellFor(row, mapping, key); }

    /* --------------------------------------------------------- identifiers */
    e.account = parsers.parseId(cell('account'));
    if (!e.account) {
      e.account = 'ROW-' + (e.sourceRowNumber || e.rowId);
      e.accountSynthetic = true;
      diag.addFor('DQ_ACCT_MISSING', e, {
        message: 'No account number on source row ' + e.sourceRowNumber + '. Assigned internal identifier ' + e.account + '.'
      });
    }
    e.mrn = parsers.parseId(cell('mrn'));
    if (!e.mrn) {
      diag.addFor('DQ_MRN_MISSING', e, {
        message: 'Account ' + e.account + ' has no MRN, so it cannot be linked to other accounts for this patient.'
      });
    }
    e.name = parsers.parseText(cell('name'));

    /* ------------------------------------------------------- service class */
    e.serviceRaw = parsers.parseText(cell('service'));
    var svc = cfgSchema.serviceBehavior(config, e.serviceRaw);
    e.serviceClass = svc.behavior;
    e.serviceLabel = svc.row ? svc.row.label : '';
    if (e.serviceClass === UR.SERVICE.UNKNOWN) {
      e.excludedReason = 'Unrecognized service code "' + e.serviceRaw + '"';
      diag.addFor('DQ_SVC_UNKNOWN', e, {
        message: 'Service code "' + e.serviceRaw + '" is not in the service-code reference table. Account ' + e.account + ' is excluded from all metrics.',
        value: e.serviceRaw
      });
    } else if (e.serviceClass === UR.SERVICE.IGNORED) {
      e.excludedReason = 'Service code "' + e.serviceRaw + '" is configured as ignored';
      diag.addFor('DQ_SVC_IGNORED', e, {
        message: 'Service code "' + e.serviceRaw + '" is configured as ignored. Account ' + e.account + ' is excluded by policy.',
        value: e.serviceRaw
      });
    } else {
      e.included = true;
    }

    /* ------------------------------------------------------------- admission */
    var admitDateRes = parsers.parseDate(cell('admitDate'));
    if (!admitDateRes.ok) {
      var admitRaw = cell('admitDate');
      if (admitRaw === null || admitRaw === undefined || String(admitRaw).trim() === '') {
        diag.addFor('DQ_ADMIT_MISSING', e, {
          message: 'Account ' + e.account + ' has no admission date. The row is excluded from all metrics.'
        });
      } else {
        diag.addFor('DQ_DATE_UNPARSEABLE', e, {
          message: 'Account ' + e.account + ': admission date "' + String(admitRaw) + '" could not be read (' + admitDateRes.reason + ').',
          value: String(admitRaw)
        });
        diag.addFor('DQ_ADMIT_MISSING', e, {
          message: 'Account ' + e.account + ' has no usable admission datetime and is excluded from all metrics.'
        });
      }
      if (!e.excludedReason) { e.excludedReason = 'Unusable admission datetime'; }
    } else {
      var admitMinutes = null;
      var admitTimeRaw = cell('admitTime');
      if (admitTimeRaw !== null && admitTimeRaw !== undefined && String(admitTimeRaw).trim() !== '') {
        var at = parsers.parseTime(admitTimeRaw);
        if (at.ok) {
          admitMinutes = at.value;
        } else {
          diag.addFor('DQ_DATE_UNPARSEABLE', e, {
            message: 'Account ' + e.account + ': admission time "' + String(admitTimeRaw) + '" could not be read (' + at.reason + '). Midnight assumed.',
            value: String(admitTimeRaw)
          });
        }
      } else if (admitDateRes.timeFromDate !== null && admitDateRes.timeFromDate !== undefined) {
        /* The date cell carried its own time component. */
        admitMinutes = admitDateRes.timeFromDate;
      }
      if (admitMinutes === null) {
        admitMinutes = 0;
        e.admitTimeAssumed = true;
        diag.addFor('DQ_TIME_MISSING', e, {
          message: 'Account ' + e.account + ' has an admission date with no usable time. Midnight assumed; hour-based metrics for this account are approximate.'
        });
      }
      e.admitDT = parsers.combine(admitDateRes.value, admitMinutes);
    }

    /* ------------------------------------------------------------- discharge */
    var disDateRaw = cell('dischargeDate');
    var disTimeRaw = cell('dischargeTime');
    var hasDisDate = !(disDateRaw === null || disDateRaw === undefined || String(disDateRaw).trim() === '');
    var hasDisTime = !(disTimeRaw === null || disTimeRaw === undefined || String(disTimeRaw).trim() === '');

    if (!hasDisDate) {
      e.isOpen = true;
      if (hasDisTime) {
        diag.addFor('DQ_DISCHARGE_MISSING', e, {
          message: 'Account ' + e.account + ' has a discharge time but no discharge date. Treated as an open encounter.'
        });
      } else {
        diag.addFor('DQ_OPEN', e, {
          message: 'Account ' + e.account + ' has no discharge date and is treated as an open encounter.'
        });
      }
    } else {
      var disDateRes = parsers.parseDate(disDateRaw);
      if (!disDateRes.ok) {
        e.isOpen = true;
        diag.addFor('DQ_DATE_UNPARSEABLE', e, {
          message: 'Account ' + e.account + ': discharge date "' + String(disDateRaw) + '" could not be read (' + disDateRes.reason + '). Treated as an open encounter.',
          value: String(disDateRaw)
        });
      } else {
        var disMinutes = null;
        if (hasDisTime) {
          var dt = parsers.parseTime(disTimeRaw);
          if (dt.ok) {
            disMinutes = dt.value;
          } else {
            diag.addFor('DQ_DATE_UNPARSEABLE', e, {
              message: 'Account ' + e.account + ': discharge time "' + String(disTimeRaw) + '" could not be read (' + dt.reason + '). Midnight assumed.',
              value: String(disTimeRaw)
            });
          }
        } else if (disDateRes.timeFromDate !== null && disDateRes.timeFromDate !== undefined) {
          disMinutes = disDateRes.timeFromDate;
        }
        if (disMinutes === null) {
          disMinutes = 0;
          e.dischargeTimeAssumed = true;
          diag.addFor('DQ_TIME_MISSING', e, {
            message: 'Account ' + e.account + ' has a discharge date with no usable time. Midnight assumed; hour-based metrics for this account are approximate.'
          });
        }
        e.dischargeDT = parsers.combine(disDateRes.value, disMinutes);
      }
    }

    /* -------------------------------------------------------------- duration */
    if (e.admitDT && e.dischargeDT) {
      var hours = util.hoursBetween(e.admitDT, e.dischargeDT);
      if (hours < 0) {
        var toleranceHours = (config.transition.overlapToleranceMinutes || 0) / 60;
        if (-hours <= toleranceHours) {
          e.durationHours = 0;
          e.durationClamped = true;
          diag.addFor('DQ_NEG_LOS', e, {
            severity: UR.SEVERITY.WARNING,
            message: 'Account ' + e.account + ' discharges ' + util.round(-hours * 60, 0) +
                     ' minutes before it admits, within the configured overlap tolerance. Duration treated as zero and flagged.'
          });
        } else {
          diag.addFor('DQ_NEG_LOS', e, {
            message: 'Account ' + e.account + ' discharges ' + util.round(-hours, 2) +
                     ' hours before it admits. The row is excluded from duration, LOS, and occupancy metrics.'
          });
          if (!e.excludedReason) { e.excludedReason = 'Discharge precedes admission'; }
        }
      } else {
        e.durationHours = hours;
      }
      if (e.durationHours !== null) {
        e.durationDays = e.durationHours / 24;
        e.midnights = util.midnightsCrossed(e.admitDT, e.dischargeDT);
      }
    }

    /* ---------------------------------------------------------------- payer */
    e.insuranceRaw = parsers.parseText(cell('insurance'));
    if (mapping.insurance) {
      if (e.insuranceRaw === '') {
        diag.addFor('DQ_INS_UNKNOWN', e, {
          message: 'Account ' + e.account + ' has no insurance code. Payer category is Unknown.'
        });
      } else {
        var ins = cfgSchema.insuranceCode(config, e.insuranceRaw);
        if (ins && ins.enabled !== false && ins.category) {
          e.payerCategory = ins.category;
          e.payerLabel = ins.label || '';
        } else {
          diag.addFor('DQ_INS_UNKNOWN', e, {
            message: 'Insurance code "' + e.insuranceRaw + '" is not mapped to a payer category. Account ' + e.account + ' groups under Unknown and is excluded from Medicare-specific review rules.',
            value: e.insuranceRaw
          });
        }
      }
    }

    /* ------------------------------------------------------- discharge code */
    e.dischargeCodeRaw = parsers.parseText(cell('dischargeCode'));
    if (e.dischargeCodeRaw !== '') {
      var dc = cfgSchema.dischargeCode(config, e.dischargeCodeRaw);
      if (dc && dc.enabled !== false) {
        e.dischargeCodeLabel = dc.label || '';
        e.dispositionCategory = dc.category || 'Other';
        e.isDeath = (dc.category === config.deathCategory);
        if (dc.transitionTo) {
          var restrict = dc.transitionFrom;
          if (!restrict || !restrict.length || util.contains(restrict, e.serviceClass)) {
            e.transitionTo = dc.transitionTo;
          } else {
            e.transitionFrom = restrict;
          }
        }
      } else {
        e.dispositionCategory = 'Unknown';
        diag.addFor('DQ_DISCD_UNKNOWN', e, {
          message: 'Discharge code "' + e.dischargeCodeRaw + '" is not in the discharge-code reference table. Account ' + e.account +
                   ' keeps its length of stay; disposition is Unknown and no status transition is assumed.',
          value: e.dischargeCodeRaw
        });
      }
    } else if (!e.isOpen && mapping.dischargeCode) {
      e.dispositionCategory = 'Unknown';
      diag.addFor('DQ_DISCD_UNKNOWN', e, {
        message: 'Account ' + e.account + ' is discharged but carries no discharge code. Disposition is Unknown and no status transition is assumed.'
      });
    }

    /* ----------------------------------------------------- admission source */
    e.admissionSourceRaw = parsers.parseText(cell('admissionSource'));
    if (mapping.admissionSource && e.admissionSourceRaw !== '') {
      var src = cfgSchema.admissionSource(config, e.admissionSourceRaw);
      if (src && src.enabled !== false) {
        e.admissionSourceLabel = src.label || '';
        e.admissionSourceCategory = src.category || '';
      } else {
        diag.addFor('DQ_ADMSRC_UNKNOWN', e, {
          message: 'Admission source "' + e.admissionSourceRaw + '" is not mapped. It reports as Unknown.',
          value: e.admissionSourceRaw
        });
      }
    }

    e.metricEligible = e.included && !!e.admitDT && !e.excludedReason;
    return e;
  }

  var normalizeEncounter = {
    normalizeOne: normalizeOne,

    /*
     * Normalize every row of every selected source table.
     *
     * sources: [{ fileName, sheetName, headers, rows, mapping }]
     * Returns { encounters, duplicatesRemoved, conflicts }.
     */
    normalizeAll: function (sources, config, diag) {
      var encounters = [];
      var idCounter = { n: 0 };
      var s, r;

      for (s = 0; s < sources.length; s++) {
        var src = sources[s];
        var ctx = {
          mapping: src.mapping,
          config: config,
          diagnostics: diag,
          sourceFile: src.fileName,
          sourceSheet: src.sheetName,
          nextRowId: function () { return ++idCounter.n; }
        };
        for (r = 0; r < src.rows.length; r++) {
          encounters.push(normalizeOne(src.rows[r], ctx));
        }
      }

      /* ------------------------------------------- exact duplicate handling */
      var seen = {};
      var kept = [];
      var duplicatesRemoved = 0;
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        var sig = rowSignature(e);
        if (Object.prototype.hasOwnProperty.call(seen, sig)) {
          var first = seen[sig];
          if (config.processing.deduplicateIdenticalRows) {
            duplicatesRemoved++;
            /* The dropped copy's own findings go with it: they describe a row
             * that no longer exists, and leaving them would inflate every
             * diagnostic count above the number of retained records. */
            diag.dropRow(e.rowId);
            e.flags = [];
            diag.addFor('DQ_ROW_DEDUP', e, {
              /* Attributed to the copy that was KEPT, so the finding points at a
               * record the user can still open. */
              rowId: first.rowId,
              message: 'Account ' + e.account + ' appears identically in ' + e.sourceFile + ' (row ' + e.sourceRowNumber +
                       ') and ' + first.sourceFile + ' (row ' + first.sourceRowNumber + '). One copy was kept so it is counted once.'
            });
            continue;
          }
          diag.addFor('DQ_ROW_DUP', e, {
            message: 'Account ' + e.account + ' appears identically more than once and de-duplication is disabled, so it is counted more than once.'
          });
        } else {
          seen[sig] = e;
        }
        kept.push(e);
      }

      /* ------------------------------- conflicting duplicate account numbers */
      var byAccount = util.groupBy(kept, function (x) { return x.account; });
      var conflicts = 0;
      for (var a = 0; a < byAccount.keys.length; a++) {
        var group = byAccount.map[byAccount.keys[a]];
        if (group.length < 2) { continue; }
        var sigs = {};
        var distinct = 0;
        for (var g = 0; g < group.length; g++) {
          var cs = contentSignature(group[g]);
          if (!sigs[cs]) { sigs[cs] = true; distinct++; }
        }
        if (distinct < 2) { continue; }
        conflicts++;
        for (var h = 0; h < group.length; h++) {
          group[h].metricEligible = false;
          if (!group[h].excludedReason) { group[h].excludedReason = 'Conflicting duplicate account number'; }
          diag.addFor('DQ_ACCT_CONFLICT', group[h], {
            message: 'Account ' + group[h].account + ' appears ' + group.length + ' times with differing content. ' +
                     'No copy is merged and all copies are excluded from counts until the source export is corrected.'
          });
        }
      }

      return { encounters: kept, duplicatesRemoved: duplicatesRemoved, conflicts: conflicts };
    }
  };

  UR.normalizeEncounter = normalizeEncounter;

})(typeof globalThis !== 'undefined' ? globalThis : this);

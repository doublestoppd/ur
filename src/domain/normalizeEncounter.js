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

  /*
   * The comparable content of a row, joined on a control character so that
   * neighbouring fields cannot run together into a colliding signature.
   */
  function contentParts(e) {
    return [
      e.ageYears === null ? '' : e.ageYears, e.serviceRaw,
      e.admitDT ? e.admitDT.getTime() : '',
      e.dischargeDT ? e.dischargeDT.getTime() : '',
      e.insuranceRaw, e.dischargeCodeRaw, e.admissionSourceRaw, e.name
    ].join('');
  }

  /*
   * The identity key one patient's accounts share: normalized name plus age.
   * Case, stray spacing, and trailing punctuation are export noise, not
   * different patients - but nothing beyond that is forgiven, because merging
   * two real people is worse than splitting one.
   */
  function patientKey(name, ageYears) {
    if (!name || ageYears === null) { return ''; }
    var norm = String(name).toUpperCase().replace(/\s+/g, ' ').replace(/[ ,.]+$/, '').trim();
    if (!norm) { return ''; }
    return norm + '|' + ageYears;
  }

  /* Signature used to detect exact duplicate rows across files and sheets. */
  function rowSignature(e) {
    return e.account + '' + contentParts(e);
  }

  /*
   * Signature for conflict detection: the same content without the account
   * number. It must cover EVERY field the row signature covers. An earlier
   * version omitted the patient name and the admission source, so two rows
   * sharing an account number but differing only in those fields were neither
   * identical (so never de-duplicated) nor conflicting (so never excluded) -
   * and both were counted.
   */
  function contentSignature(e) {
    return contentParts(e);
  }

  /*
   * Report how a reference code was resolved when it was not an exact match.
   *
   * With 736 insurance codes - 21 pairs of which differ only in case and mean
   * different payers - silently accepting a near match would attribute accounts
   * to the wrong payer. An inexact match is applied but reported; an ambiguous
   * one is refused.
   */
  function reportCodeMatch(diag, encounter, lookup, kindLabel, rawValue) {
    if (!lookup || !lookup.match || lookup.match === 'exact') { return; }
    if (lookup.match === 'ambiguous') {
      var codes = [];
      for (var i = 0; i < lookup.candidates.length; i++) { codes.push(lookup.candidates[i].code); }
      diag.addFor('DQ_CODE_AMBIGUOUS', encounter, {
        message: kindLabel + ' "' + rawValue + '" on account ' + encounter.account +
                 ' matches ' + lookup.candidates.length + ' reference entries when case or leading zeros are ignored (' +
                 codes.join(', ') + '). No mapping was applied; these are different codes and the tool will not guess between them.',
        value: rawValue
      });
      return;
    }
    diag.addFor('DQ_CODE_INEXACT', encounter, {
      message: kindLabel + ' "' + rawValue + '" on account ' + encounter.account + ' matched reference entry "' +
               lookup.row.code + '"' + (lookup.match === 'numeric'
                 ? ' by numeric value; a leading zero was lost somewhere between the export and the reference table.'
                 : ' by letter case only.'),
      value: rawValue
    });
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
      /* mrn carries the DERIVED Patient ID (assigned in normalizeAll from
       * name + age; the export has no medical record number). The field name
       * is kept because every downstream consumer treats it as the patient
       * grouping key. */
      mrn: '', name: '', ageYears: null, patientKey: '',
      serviceRaw: '', serviceClass: UR.SERVICE.UNKNOWN, serviceLabel: '',
      admitDT: null, dischargeDT: null,
      admitTimeAssumed: false, dischargeTimeAssumed: false,
      isOpen: false,
      durationHours: null, durationDays: null, midnights: null, durationClamped: false,
      insuranceRaw: '', payerCategory: UR.PAYER_CATEGORY.UNKNOWN, payerLabel: '',
      dischargeCodeRaw: '', dischargeCodeLabel: '', dispositionCategory: '', isDeath: false,
      transitionTo: null, transitionFrom: null,
      admissionSourceRaw: '', admissionSourceLabel: '', admissionSourceCategory: '',

      raw: {},              /* source cell values, by canonical field */
      included: false,      /* service maps to IP / OS / SB */
      metricEligible: false,/* may contribute to metrics */
      excludedReason: '',
      episodeId: null,
      linkPrev: null, linkNext: null,
      reviewFlags: [],
      flags: []
    };

    function cell(key) { return reader.cellFor(row, mapping, key); }

    /*
     * Keep every mapped source cell exactly as it arrived, beside the column it
     * came from. The account detail view shows these next to the interpreted
     * values so a reviewer can check the tool's reading against the chart -
     * an Excel serial of 46236 displayed beside "08/03/2026" is what makes the
     * interpretation checkable rather than something to take on trust.
     *
     * In memory only, exactly like the rest of the encounter: never persisted.
     */
    for (var fi = 0; fi < UR.headerMapper.FIELDS.length; fi++) {
      var fkey = UR.headerMapper.FIELDS[fi].key;
      var m = mapping[fkey];
      var rawValue = m ? cell(fkey) : undefined;
      e.raw[fkey] = {
        column: m ? m.header : null,
        value: rawValue === undefined ? null : rawValue,
        type: rawValue === null || rawValue === undefined ? 'blank' : (typeof rawValue)
      };
    }

    /* --------------------------------------------------------- identifiers */
    e.account = parsers.parseId(cell('account'));
    if (!e.account) {
      e.account = 'ROW-' + (e.sourceRowNumber || e.rowId);
      e.accountSynthetic = true;
      diag.addFor('DQ_ACCT_MISSING', e, {
        message: 'No account number on source row ' + e.sourceRowNumber + '. Assigned internal identifier ' + e.account + '.'
      });
    }
    e.name = parsers.parseText(cell('name'));

    /* ------------------------------------------------- patient identity */
    var ageRaw = cell('ageYears');
    var hasAgeCell = !(ageRaw === null || ageRaw === undefined || String(ageRaw).trim() === '');
    if (hasAgeCell) {
      var ageNum = Number(String(ageRaw).trim());
      if (isFinite(ageNum) && ageNum >= 0 && ageNum <= 130 && ageNum === Math.floor(ageNum)) {
        e.ageYears = ageNum;
      } else {
        diag.addFor('DQ_PID_MISSING', e, {
          message: 'Account ' + e.account + ': age "' + String(ageRaw) +
                   '" is not a usable whole number of years (0-130), so no Patient ID can be derived. ' +
                   'The account cannot be linked to other accounts for this patient.',
          value: String(ageRaw)
        });
      }
    }
    e.patientKey = patientKey(e.name, e.ageYears);
    if (!e.patientKey) {
      if (!e.name && !hasAgeCell) {
        diag.addFor('DQ_PID_MISSING', e, {
          message: 'Account ' + e.account + ' has neither a patient name nor an age, so no Patient ID can be derived. It cannot be linked to other accounts.'
        });
      } else if (!e.name) {
        diag.addFor('DQ_PID_MISSING', e, {
          message: 'Account ' + e.account + ' has no patient name, so no Patient ID can be derived. It cannot be linked to other accounts.'
        });
      } else if (!hasAgeCell) {
        diag.addFor('DQ_PID_MISSING', e, {
          message: 'Account ' + e.account + ' has no age, so no Patient ID can be derived. It cannot be linked to other accounts.'
        });
      }
      /* the unusable-age case was already reported above, with the value */
    }

    /* ------------------------------------------------------- service class */
    e.serviceRaw = parsers.parseText(cell('service'));
    var svc = cfgSchema.serviceBehavior(config, e.serviceRaw);
    reportCodeMatch(diag, e, svc, 'Service code', e.serviceRaw);
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
        } else if (admitDateRes.timeFromDate !== null && admitDateRes.timeFromDate !== undefined) {
          /* The date cell carried its own HH:MM; better than assuming midnight. */
          admitMinutes = admitDateRes.timeFromDate;
          diag.addFor('DQ_DATE_UNPARSEABLE', e, {
            message: 'Account ' + e.account + ': admission time "' + String(admitTimeRaw) + '" could not be read (' + at.reason +
                     '). Using the time embedded in the admission date cell instead.',
            value: String(admitTimeRaw)
          });
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
          } else if (disDateRes.timeFromDate !== null && disDateRes.timeFromDate !== undefined) {
            disMinutes = disDateRes.timeFromDate;
            diag.addFor('DQ_DATE_UNPARSEABLE', e, {
              message: 'Account ' + e.account + ': discharge time "' + String(disTimeRaw) + '" could not be read (' + dt.reason +
                       '). Using the time embedded in the discharge date cell instead.',
              value: String(disTimeRaw)
            });
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
                     ' hours before it admits. The row is excluded from ALL figures - admissions, patients, ' +
                     'LOS, occupancy, and review lists - until the dates are corrected in the source system.'
          });
          if (!e.excludedReason) { e.excludedReason = 'Discharge precedes admission'; }
        }
      } else {
        e.durationHours = hours;
        if (hours === 0 && !e.durationClamped) {
          /* Admit and discharge at the same minute: almost certainly a
           * registration artifact. The row stays in the figures (excluding it
           * would silently change counts) but is flagged, because a genuine
           * zero-length stay deflates the LOS averages. */
          diag.addFor('DQ_ZERO_LOS', e, {
            severity: UR.SEVERITY.WARNING,
            message: 'Account ' + e.account + ' admits and discharges at the same minute (' +
                     util.fmtDateTime(e.admitDT) + '). The zero-length stay counts in LOS averages and the ' +
                     'lowest LOS distribution band, but not in the one-day-stay count, which requires a positive duration. ' +
                     'Verify the times in the source system.'
          });
        }
      }
      if (e.durationHours !== null) {
        e.durationDays = e.durationHours / 24;
        /* A clamped inversion is treated as an instantaneous stay: its
         * contradictory raw times would otherwise yield a negative midnight
         * count, which is nonsensical in every consumer (two-midnight rule,
         * review rows). */
        e.midnights = e.durationClamped ? 0 : util.midnightsCrossed(e.admitDT, e.dischargeDT);
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
        var insLookup = cfgSchema.insuranceLookup(config, e.insuranceRaw);
        reportCodeMatch(diag, e, insLookup, 'Insurance code', e.insuranceRaw);
        var ins = insLookup.row;
        if (ins && ins.enabled !== false && ins.category && ins.category !== UR.PAYER_CATEGORY.UNKNOWN) {
          e.payerCategory = ins.category;
          e.payerLabel = ins.label || '';
        } else if (ins && ins.enabled === false) {
          e.payerLabel = ins.label || '';
          diag.addFor('DQ_CODE_RETIRED', e, {
            message: 'Insurance code "' + e.insuranceRaw + '" (' + (ins.label || 'no description') +
                     ') is marked retired in the reference table. Account ' + e.account +
                     ' groups under Unknown and is excluded from Medicare-specific review rules.',
            value: e.insuranceRaw
          });
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
      var dcLookup = cfgSchema.dischargeLookup(config, e.dischargeCodeRaw);
      reportCodeMatch(diag, e, dcLookup, 'Discharge code', e.dischargeCodeRaw);
      var dc = dcLookup.row;
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
      var srcLookup = cfgSchema.admissionSourceLookup(config, e.admissionSourceRaw);
      reportCodeMatch(diag, e, srcLookup, 'Admission source', e.admissionSourceRaw);
      var src = srcLookup.row;
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

      assignPatientIds(kept, diag);

      return { encounters: kept, duplicatesRemoved: duplicatesRemoved, conflicts: conflicts };
    }
  };

  /*
   * Derived patient identity: every distinct (normalized name, age) pair gets
   * one Patient ID, assigned in sorted order so the same data always yields
   * the same IDs. The ID is written to e.mrn - the patient grouping key every
   * downstream module already consumes.
   *
   * Two limitations are inherent to name+age identity and are surfaced rather
   * than hidden: two different people sharing a name and age become one
   * patient (undetectable here), and one person whose birthday falls between
   * two stays becomes two patients - the adjacent-age case IS detectable, so
   * it is reported (DQ_PID_SPLIT) and never silently merged.
   */
  function assignPatientIds(encounters, diag) {
    var keys = [];
    var seen = {};
    var i, e;
    for (i = 0; i < encounters.length; i++) {
      e = encounters[i];
      if (e.patientKey && !seen[e.patientKey]) {
        seen[e.patientKey] = true;
        keys.push(e.patientKey);
      }
    }
    keys.sort();
    var width = Math.max(3, String(keys.length).length);
    var idByKey = {};
    for (i = 0; i < keys.length; i++) {
      var ordinal = String(i + 1);
      while (ordinal.length < width) { ordinal = '0' + ordinal; }
      idByKey[keys[i]] = 'P' + ordinal;
    }
    var firstByKey = {};
    for (i = 0; i < encounters.length; i++) {
      e = encounters[i];
      e.mrn = e.patientKey ? idByKey[e.patientKey] : '';
      if (e.patientKey && !firstByKey[e.patientKey]) { firstByKey[e.patientKey] = e; }
    }

    /* Same name, ages one apart: possibly one person crossing a birthday. */
    for (i = 0; i < keys.length; i++) {
      var parts = keys[i].split('|');
      var neighbour = parts[0] + '|' + (Number(parts[1]) + 1);
      if (!idByKey[neighbour]) { continue; }
      var a = firstByKey[keys[i]];
      var b = firstByKey[neighbour];
      diag.addFor('DQ_PID_SPLIT', a, {
        message: 'Patients ' + idByKey[keys[i]] + ' (age ' + parts[1] + ') and ' + idByKey[neighbour] +
                 ' (age ' + (Number(parts[1]) + 1) + ') share the name "' + a.name +
                 '" with ages one year apart, and MAY be one person whose birthday falls inside the data. ' +
                 'They are treated as two patients, so no episode or readmission will connect their accounts (for example ' +
                 a.account + ' and ' + b.account + '). If the chart shows one person, correct the age at the source and reprocess.'
      });
    }
  }

  UR.normalizeEncounter = normalizeEncounter;

})(typeof globalThis !== 'undefined' ? globalThis : this);

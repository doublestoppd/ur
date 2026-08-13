/*
 * reviewQueue.js - generates the objective account-level review queue
 * (spec 10).
 *
 * The queue answers one question: which accounts should a human look at? It
 * never answers whether a stay was medically necessary, correctly statused,
 * payable, or compliant. Each generator below is bound to a rule id in
 * config/reviewRules.js, which supplies the wording, thresholds, and
 * disclaimers shown in the UI and the workbook.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;

  /* Diagnostic ids that belong on a reviewer's work list (spec 10, RQ_DATA). */
  var DATA_WARNINGS = ['DQ_SVC_UNKNOWN', 'DQ_PID_MISSING', 'DQ_PID_MERGED', 'DQ_ACCT_CONFLICT', 'DQ_ROW_DUP', 'DQ_OVERLAP_UNEXPLAINED', 'DQ_TRANS_UNMODELED', 'DQ_MANUAL_OS'];

  function baseRow(ruleId, enc, extra) {
    var rule = UR.reviewRules.byId(ruleId);
    var row = {
      ruleId: ruleId,
      ruleName: rule ? rule.name : ruleId,
      priority: rule ? rule.priority : 99,
      account: enc ? enc.account : '',
      mrn: enc ? enc.mrn : '',
      patientName: enc ? enc.name : '',
      service: enc ? enc.serviceClass : '',
      payerCategory: enc ? enc.payerCategory : '',
      admit: enc ? enc.admitDT : null,
      discharge: enc ? enc.dischargeDT : null,
      episodeId: enc ? enc.episodeId : '',
      isOpen: enc ? !!enc.isOpen : false,
      losHours: enc ? enc.durationHours : null,
      midnights: enc ? enc.midnights : null,
      relatedAccount: '',
      measure: null,
      measureLabel: '',
      detail: ''
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) { row[k] = extra[k]; }
      }
    }
    return row;
  }

  /* Elapsed hours for an open account, measured to the as-of datetime. */
  function openHours(enc, period) {
    if (!enc.admitDT) { return null; }
    return util.hoursBetween(enc.admitDT, period.asOf);
  }

  function isMedicare(enc) {
    return util.contains(UR.MEDICARE_CATEGORIES, enc.payerCategory);
  }

  var generators = {

    RQ_IP_GT4: function (ctx) {
      var rows = [];
      var detail = ctx.metrics.inpatient.IP_GT4_001.detail;
      for (var i = 0; i < detail.length; i++) {
        var e = detail[i].encounter;
        rows.push(baseRow('RQ_IP_GT4', e, {
          measure: e.durationHours,
          measureLabel: 'LOS hours',
          detail: util.round(e.durationHours, 1) + ' hours (' + util.round(e.durationDays, 2) + ' days); ' +
                  util.round(detail[i].excessDays, 2) + ' days above the ' + ctx.config.thresholds.acuteTargetHours + '-hour target.',
          excessDays: detail[i].excessDays
        }));
      }
      return rows;
    },

    RQ_OS_24: function (ctx) { return observationThreshold(ctx, 'RQ_OS_24', 0); },
    RQ_OS_36: function (ctx) { return observationThreshold(ctx, 'RQ_OS_36', 1); },
    RQ_OS_48: function (ctx) { return observationThreshold(ctx, 'RQ_OS_48', 2); },

    RQ_OS_IP: function (ctx) {
      var rows = [];
      var conv = ctx.metrics.observation.OSIP_001.detail;
      for (var i = 0; i < conv.length; i++) {
        var c = conv[i];
        rows.push(baseRow('RQ_OS_IP', c.os, {
          relatedAccount: c.ip ? c.ip.account : '',
          measure: c.osHours,
          measureLabel: 'Observation hours before conversion',
          detail: 'Converted to inpatient account ' + (c.ip ? c.ip.account : '?') + ' after ' +
                  (c.osHours === null ? 'unknown' : util.round(c.osHours, 1)) + ' observation hours; ' +
                  util.round(c.link.gapMinutes, 0) + '-minute gap; link ' + c.link.confidence.toLowerCase() + '.',
          gapMinutes: c.link.gapMinutes,
          linkConfidence: c.link.confidence
        }));
      }
      return rows;
    },

    RQ_IP_SB: function (ctx) { return transitionRows(ctx, 'RQ_IP_SB', ctx.metrics.swingBed.IPSB_001.detail); },
    RQ_SB_IP: function (ctx) { return transitionRows(ctx, 'RQ_SB_IP', ctx.metrics.swingBed.SBIP_001.detail); },

    RQ_SHORT_MCR: function (ctx) {
      var rows = [];
      var list = ctx.metrics.inpatient.IP_2MN_001.encounters;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        rows.push(baseRow('RQ_SHORT_MCR', e, {
          measure: e.midnights,
          measureLabel: 'Midnights crossed',
          detail: e.midnights + ' midnight(s) crossed over ' + util.round(e.durationHours, 1) +
                  ' hours, payer ' + e.payerCategory + '. Status-review candidate only.'
        }));
      }
      return rows;
    },

    RQ_1DAY: function (ctx) {
      var rows = [];
      var list = ctx.metrics.inpatient.IP_SHORT_001.encounters;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        rows.push(baseRow('RQ_1DAY', e, {
          measure: e.durationHours,
          measureLabel: 'LOS hours',
          detail: util.round(e.durationHours, 1) + ' hours, ' + (e.midnights === null ? '?' : e.midnights) +
                  ' midnight(s), payer ' + e.payerCategory + '.'
        }));
      }
      return rows;
    },

    RQ_READMIT_7: function (ctx) { return readmissionRows(ctx, 'RQ_READMIT_7', ctx.config.thresholds.readmissionWindowDays[0]); },
    RQ_READMIT_30: function (ctx) { return readmissionRows(ctx, 'RQ_READMIT_30', ctx.config.thresholds.readmissionWindowDays[1]); },

    RQ_IMM: function (ctx) {
      var rows = [];
      /* In scope = the stay overlaps the period (even partially) or is
       * counted in this period's discharged-stay figures. */
      var list = scope.inScopeOrCounted(ctx.encounters, UR.SERVICE.IP, ctx.config, ctx.period);
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!isMedicare(e)) { continue; }
        rows.push(baseRow('RQ_IMM', e, {
          measure: e.durationHours,
          measureLabel: 'LOS hours',
          detail: 'Medicare inpatient admission (' + e.payerCategory + '). Manual verification required: the export cannot show whether the Important Message was delivered or signed.'
        }));
      }
      return rows;
    },

    RQ_MOON: function (ctx) {
      var rows = [];
      var threshold = ctx.config.thresholds.moonThresholdHours;
      var escalated = ctx.config.thresholds.obsThresholdHours[1];
      var list = scope.inScopeOrCounted(ctx.encounters, UR.SERVICE.OS, ctx.config, ctx.period);
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!isMedicare(e)) { continue; }
        var hours = e.isOpen ? openHours(e, ctx.period) : e.durationHours;
        if (hours === null || hours <= threshold) { continue; }
        rows.push(baseRow('RQ_MOON', e, {
          measure: hours,
          measureLabel: 'Observation hours',
          detail: util.round(hours, 1) + ' observation hours' + (e.isOpen ? ' and still open at ' + util.fmtDateTime(ctx.period.asOf) : '') +
                  '; past ' + threshold + 'h' + (hours > escalated ? ', past ' + escalated + 'h' : '') +
                  '. Manual verification required: the export cannot show whether a MOON was delivered or signed.',
          past24: hours > threshold,
          past36: hours > escalated
        }));
      }
      return rows;
    },

    RQ_TRANSITION: function (ctx) {
      var rows = [];
      var byRowId = {};
      var i;
      for (i = 0; i < ctx.encounters.length; i++) { byRowId[ctx.encounters[i].rowId] = ctx.encounters[i]; }

      for (i = 0; i < ctx.transitions.length; i++) {
        var t = ctx.transitions[i];
        var problem = (t.confidence === UR.LINK_CONFIDENCE.AMBIGUOUS ||
                       t.confidence === UR.LINK_CONFIDENCE.MISSING ||
                       t.confidence === UR.LINK_CONFIDENCE.REFUSED ||
                       t.confidence === UR.LINK_CONFIDENCE.UNLINKED ||
                       t.confidence === UR.LINK_CONFIDENCE.PROBABLE ||
                       (t.gapMinutes !== null && t.gapMinutes > ctx.config.transition.suspiciousGapMinutes));
        if (!problem) { continue; }
        var enc = byRowId[t.fromRowId];
        if (!enc || !scope.overlapsPeriod(enc, ctx.period)) { continue; }
        rows.push(baseRow('RQ_TRANSITION', enc, {
          relatedAccount: t.toAccount || t.candidateAccounts.join(', '),
          measure: t.gapMinutes,
          measureLabel: 'Gap minutes',
          detail: '[' + t.confidence + '] ' + (t.issue || '') +
                  (t.expectedService ? ' Expected next service: ' + t.expectedService + '.' : '') +
                  (t.dischargeCode ? ' Discharge code "' + t.dischargeCode + '".' : ''),
          linkConfidence: t.confidence
        }));
      }
      return rows;
    },

    RQ_DATA: function (ctx) {
      var rows = [];
      var byAccount = {};
      var all = ctx.diagnostics.all();
      for (var i = 0; i < all.length; i++) {
        var d = all[i];
        if (!d.account) { continue; }
        var relevant = d.severity === UR.SEVERITY.BLOCKING || d.severity === UR.SEVERITY.ERROR ||
                       util.contains(DATA_WARNINGS, d.ruleId);
        if (!relevant) { continue; }
        if (!byAccount[d.account]) { byAccount[d.account] = []; }
        byAccount[d.account].push(d);
      }
      var encByAccount = {};
      for (var j = 0; j < ctx.encounters.length; j++) { encByAccount[ctx.encounters[j].account] = ctx.encounters[j]; }

      for (var acct in byAccount) {
        if (!Object.prototype.hasOwnProperty.call(byAccount, acct)) { continue; }
        var items = byAccount[acct];
        var enc = encByAccount[acct];
        var messages = [];
        var ids = [];
        var worst = UR.SEVERITY.INFO;
        for (var k = 0; k < items.length; k++) {
          messages.push(items[k].message);
          if (ids.indexOf(items[k].ruleId) < 0) { ids.push(items[k].ruleId); }
          if (UR.SEVERITY_ORDER.indexOf(items[k].severity) < UR.SEVERITY_ORDER.indexOf(worst)) { worst = items[k].severity; }
        }
        rows.push(baseRow('RQ_DATA', enc || null, {
          account: acct,
          mrn: enc ? enc.mrn : (items[0].mrn || ''),
          service: enc ? enc.serviceClass : (items[0].service || ''),
          measureLabel: 'Severity',
          severity: worst,
          diagnosticRules: ids.join(', '),
          detail: messages.join(' ')
        }));
      }
      rows.sort(function (a, b) {
        var sa = UR.SEVERITY_ORDER.indexOf(a.severity), sb = UR.SEVERITY_ORDER.indexOf(b.severity);
        return sa !== sb ? sa - sb : (a.account < b.account ? -1 : 1);
      });
      return rows;
    }
  };

  function observationThreshold(ctx, ruleId, thresholdIndex) {
    var rows = [];
    var limit = ctx.config.thresholds.obsThresholdHours[thresholdIndex];
    if (limit === undefined) { return rows; }
    var i, e;

    /*
     * The WORK LIST is overlap-gated, like RQ_MOON: any observation stay in
     * scope during the period that passed the threshold belongs on it,
     * including stays whose counting date (losBasis) falls outside the
     * period. The OS_24/36/48 COUNT metrics stay anchored on discharged
     * stays counted by the losBasis date, so a row is annotated when it is
     * on the list but outside that count.
     */
    var ruleIds = ['OS_24_001', 'OS_36_001', 'OS_48_001'];
    var metric = ctx.metrics.observation[ruleIds[thresholdIndex]];
    var counted = {};
    if (metric) {
      for (i = 0; i < metric.encounters.length; i++) { counted[metric.encounters[i].rowId] = true; }
    }

    var inScope = scope.inScopeOrCounted(ctx.encounters, UR.SERVICE.OS, ctx.config, ctx.period);
    for (i = 0; i < inScope.length; i++) {
      e = inScope[i];
      if (e.isOpen) { continue; } /* open stays handled below with as-of hours */
      if (e.durationHours === null || e.durationHours <= limit) { continue; }
      rows.push(baseRow(ruleId, e, {
        measure: e.durationHours,
        measureLabel: 'Observation hours',
        detail: util.round(e.durationHours, 1) + ' observation hours (threshold ' + limit + 'h).' +
                (counted[e.rowId] ? '' : ' In scope by stay overlap; outside the discharged-stay COUNT metric, which anchors on the ' +
                 ctx.config.processing.losBasis + ' date.')
      }));
    }

    /* Patients still in observation who have already passed the threshold. */
    var open = scope.openAccounts(ctx.encounters, UR.SERVICE.OS);
    for (i = 0; i < open.length; i++) {
      e = open[i];
      if (!scope.overlapsPeriod(e, ctx.period)) { continue; }
      var hours = openHours(e, ctx.period);
      if (hours === null || hours <= limit) { continue; }
      rows.push(baseRow(ruleId, e, {
        measure: hours,
        measureLabel: 'Observation hours',
        detail: util.round(hours, 1) + ' observation hours as of ' + util.fmtDateTime(ctx.period.asOf) +
                ' and still open (threshold ' + limit + 'h). Excluded from the OS threshold COUNT metric, which uses discharged stays only.'
      }));
    }
    return rows;
  }

  function transitionRows(ctx, ruleId, detail) {
    var rows = [];
    for (var i = 0; i < detail.length; i++) {
      var d = detail[i];
      rows.push(baseRow(ruleId, d.from, {
        relatedAccount: d.to ? d.to.account : '',
        measure: d.link.gapMinutes,
        measureLabel: 'Gap minutes',
        detail: d.from.serviceClass + ' account ' + d.from.account + ' -> ' + d.link.toService + ' account ' +
                (d.to ? d.to.account : '?') + '; ' + util.round(d.link.gapMinutes, 0) + '-minute gap; link ' +
                d.link.confidence.toLowerCase() + '; episode ' + (d.from.episodeId || '?') + '.',
        gapMinutes: d.link.gapMinutes,
        linkConfidence: d.link.confidence
      }));
    }
    return rows;
  }

  function readmissionRows(ctx, ruleId, windowDays) {
    var rows = [];
    if (windowDays === undefined) { return rows; }
    var pairs = UR.readmissionDetector.within(ctx.readmissions.pairs, windowDays);
    var encByAccount = {};
    for (var j = 0; j < ctx.encounters.length; j++) { encByAccount[ctx.encounters[j].account] = ctx.encounters[j]; }
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      var enc = encByAccount[p.newIPAccount];
      if (enc && !scope.inPeriod(enc.admitDT, ctx.period)) { continue; }
      rows.push(baseRow(ruleId, enc || null, {
        account: p.newIPAccount,
        mrn: p.mrn,
        patientName: p.patientName,
        relatedAccount: p.priorAccounts,
        measure: p.daysBetween,
        measureLabel: 'Days since prior discharge',
        detail: util.round(p.daysBetween, 2) + ' days after episode ' + p.priorEpisodeId + ' was discharged on ' +
                util.fmtDateTime(p.priorFinalDischarge) + ' (disposition: ' + p.priorDisposition + '). Payer ' + p.payerCategory + '.',
        priorEpisodeId: p.priorEpisodeId,
        priorFinalDischarge: p.priorFinalDischarge,
        priorDisposition: p.priorDisposition,
        daysBetween: p.daysBetween
      }));
    }
    return rows;
  }

  var reviewQueue = {
    generators: generators,

    /*
     * Build the queue. Returns { rows, byRule, byAccount, counts }.
     * One account may appear under several rules - that is intended (spec 10).
     */
    build: function (ctx) {
      var rows = [];
      var counts = {};
      var ids = UR.reviewRules.ids();
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var gen = generators[id];
        if (!gen) { counts[id] = 0; continue; }
        var produced = gen(ctx) || [];
        counts[id] = produced.length;
        for (var j = 0; j < produced.length; j++) { rows.push(produced[j]); }
      }

      rows.sort(function (a, b) {
        if (a.priority !== b.priority) { return a.priority - b.priority; }
        if (a.ruleId !== b.ruleId) { return a.ruleId < b.ruleId ? -1 : 1; }
        return a.account < b.account ? -1 : (a.account > b.account ? 1 : 0);
      });

      /* Grouped view: one row per account with every reason attached. */
      var grouped = util.groupBy(rows, function (r) { return r.account; });
      var byAccount = [];
      for (var g = 0; g < grouped.keys.length; g++) {
        var items = grouped.map[grouped.keys[g]];
        var ruleIds = [];
        var reasons = [];
        for (var k = 0; k < items.length; k++) {
          if (ruleIds.indexOf(items[k].ruleId) < 0) { ruleIds.push(items[k].ruleId); }
          reasons.push(items[k].ruleName + ': ' + items[k].detail);
        }
        byAccount.push({
          account: grouped.keys[g],
          mrn: items[0].mrn,
          patientName: items[0].patientName,
          service: items[0].service,
          payerCategory: items[0].payerCategory,
          admit: items[0].admit,
          discharge: items[0].discharge,
          episodeId: items[0].episodeId,
          reasonCount: items.length,
          ruleIds: ruleIds.join(', '),
          reasons: reasons.join(' | '),
          topPriority: items[0].priority
        });
      }
      byAccount.sort(function (a, b) {
        if (a.topPriority !== b.topPriority) { return a.topPriority - b.topPriority; }
        return b.reasonCount - a.reasonCount;
      });

      return { rows: rows, byAccount: byAccount, counts: counts };
    }
  };

  UR.reviewQueue = reviewQueue;

})(typeof globalThis !== 'undefined' ? globalThis : this);

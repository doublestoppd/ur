/*
 * pipeline.js - the deterministic processing pipeline (spec 3).
 *
 *   normalize -> validate -> link transitions -> build episodes ->
 *   detect readmissions -> calculate metrics -> inventory codes ->
 *   build review queue
 *
 * Given identical inputs and configuration, this produces identical output.
 * Nothing here reaches the network, and nothing here writes to storage.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;

  /*
   * Operator-entered observation segments (spec deviation, hospital-directed):
   * CPSI sometimes exports a stay that began in observation as a single IP
   * account with no OS row. The operator supplies the observation admit and
   * discharge datetimes for that IP account; this step then
   *
   *   1. creates a synthetic OS account named <account>-MANUAL carrying those
   *      datetimes and discharge code B (09 ADMITTED OP TO IP), so the normal
   *      transition linker connects it to the IP account like any real row;
   *   2. moves the IP admission forward to the observation discharge, so the
   *      observation hours are no longer double-counted as inpatient time;
   *   3. raises an Info note (DQ_MANUAL_OS) on both accounts, which also lands
   *      on the review queue, so the manual entry is never invisible.
   *
   * Entries live only in the operator's session - nothing is written to
   * storage - and every applied entry is listed in the workbook Run Metadata.
   * An entry that fails validation is refused with a warning naming why.
   */
  function applyManualObservations(state, entries, config, diag) {
    var byAccount = {};
    var i, e;
    for (i = 0; i < state.encounters.length; i++) {
      e = state.encounters[i];
      if (!byAccount[e.account]) { byAccount[e.account] = e; }
    }

    function refuse(entry, why) {
      diag.add('DQ_MANUAL_OS_REFUSED', {
        message: 'The manual observation segment for account ' + entry.account + ' was NOT applied: ' + why
      });
    }

    for (i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var target = byAccount[entry.account];
      var osAdmit = entry.osAdmitDT;
      var osDis = entry.osDischargeDT;

      if (!target) { refuse(entry, 'no imported account carries that number.'); continue; }
      if (target.serviceClass !== UR.SERVICE.IP) { refuse(entry, 'the account is ' + target.serviceClass + ', not IP.'); continue; }
      if (!target.metricEligible || !target.admitDT) { refuse(entry, 'the account is excluded from metrics, so a segment cannot attach to it.'); continue; }
      if (!util.isDate(osAdmit) || !util.isDate(osDis)) { refuse(entry, 'the observation datetimes are unusable.'); continue; }
      if (osDis.getTime() <= osAdmit.getTime()) { refuse(entry, 'the observation discharge must come after the observation admission.'); continue; }
      var originalAdmit = target.admitDT;
      if (osDis.getTime() < originalAdmit.getTime()) { refuse(entry, 'the observation discharge precedes the recorded inpatient admission; the inpatient admission only ever moves FORWARD.'); continue; }
      if (target.dischargeDT && osDis.getTime() >= target.dischargeDT.getTime()) { refuse(entry, 'the observation discharge must precede the inpatient discharge.'); continue; }
      var manualAccount = entry.account + '-MANUAL';
      if (byAccount[manualAccount]) { refuse(entry, 'an account named ' + manualAccount + ' already exists.'); continue; }

      var codeB = UR.configSchema.dischargeCode(config, 'B');
      var os = {};
      for (var k in target) {
        if (Object.prototype.hasOwnProperty.call(target, k)) { os[k] = target[k]; }
      }
      os.rowId = 'manual-os:' + entry.account;
      os.account = manualAccount;
      os.serviceClass = UR.SERVICE.OS;
      os.serviceCodeRaw = 'OS (manual)';
      os.admitDT = osAdmit;
      os.dischargeDT = osDis;
      os.isOpen = false;
      os.durationHours = util.hoursBetween(osAdmit, osDis);
      os.durationDays = os.durationHours / 24;
      os.midnights = util.midnightsCrossed(osAdmit, osDis);
      os.dischargeCodeRaw = 'B';
      os.dischargeCodeLabel = codeB ? codeB.label : '09 ADMITTED OP TO IP';
      os.dispositionCategory = codeB ? codeB.category : 'Internal transition';
      os.transitionTo = UR.SERVICE.IP;
      os.transitionFrom = codeB ? codeB.transitionFrom : null;
      os.isDeath = false;
      os.excludedReason = null;
      os.metricEligible = true;
      os.sourceFile = 'Manual entry';
      os.sourceSheet = '-';
      os.sourceRowNumber = '-';
      os.manualEntry = true;
      state.encounters.push(os);
      byAccount[manualAccount] = os;

      target.manualObsOriginalAdmit = originalAdmit;
      target.admitDT = osDis;
      if (target.dischargeDT) {
        target.durationHours = util.hoursBetween(target.admitDT, target.dischargeDT);
        target.durationDays = target.durationHours / 24;
        target.midnights = util.midnightsCrossed(target.admitDT, target.dischargeDT);
      }
      target.manualObsAdjusted = true;

      state.manualObservationsApplied.push({
        account: entry.account,
        manualAccount: manualAccount,
        osAdmitDT: osAdmit,
        osDischargeDT: osDis,
        admitMovedFrom: originalAdmit
      });

      diag.addFor('DQ_MANUAL_OS', target, {
        message: 'Account ' + entry.account + ': an observation segment was added MANUALLY as ' + manualAccount +
                 ' (' + util.fmtDateTime(osAdmit) + ' to ' + util.fmtDateTime(osDis) + '), and the inpatient admission was moved forward from ' +
                 util.fmtDateTime(originalAdmit) + ' to ' + util.fmtDateTime(osDis) + ' so the observation hours are not double-counted as inpatient time. ' +
                 'This entry lives only in this session; the durable fix is correcting the export or the source system.'
      });
      diag.addFor('DQ_MANUAL_OS', os, {
        message: 'Account ' + manualAccount + ' is a MANUALLY ENTERED observation segment for account ' + entry.account +
                 '; it exists in this session only and is not part of the imported export.'
      });
    }
  }

  function calculateAll(encounters, transitions, episodes, config, period) {
    return {
      inpatient: UR.metrics.inpatient.calculate(encounters, config, period),
      observation: UR.metrics.observation.calculate(encounters, transitions, config, period),
      swingBed: UR.metrics.swingBed.calculate(encounters, transitions, config, period),
      census: UR.metrics.census.calculate(encounters, episodes, config, period),
      payer: UR.metrics.payer.calculate(encounters, episodes, config, period)
    };
  }

  var pipeline = {

    /*
     * sources: [{ fileName, sheetName, headers, rows, mapping }]
     * options: { periodStart, periodEnd, asOf, manualObservations }
     *   manualObservations: [{ account, osAdmitDT, osDischargeDT }] - operator-
     *   entered observation segments for IP accounts whose observation stay
     *   CPSI did not export (see applyManualObservations below).
     *
     * Returns a state object. When `blocked` is true, `diagnostics` explains
     * why and no metrics were produced.
     */
    process: function (sources, config, options) {
      var opts = options || {};
      var diag = UR.diagnostics.create();
      var state = {
        config: config,
        diagnostics: diag,
        sources: sources,
        blocked: false,
        encounters: [],
        transitions: [],
        episodes: [],
        readmissions: null,
        metrics: null,
        monthly: [],
        codeInventory: [],
        reviewQueue: null,
        period: null,
        mapping: sources.length ? sources[0].mapping : {},
        duplicatesRemoved: 0,
        accountConflicts: 0
      };

      if (!UR.validators.validateSources(sources, diag)) {
        state.blocked = true;
        return state;
      }

      /*
       * The mapping screen validates the first file. When several files are
       * imported together the others may not carry the same columns, and their
       * rows would then fall out of every metric with nothing naming the file
       * responsible. Report each shortfall against its own file.
       */
      UR.validators.reportSourceMappings(sources, diag);

      var normalized = UR.normalizeEncounter.normalizeAll(sources, config, diag);
      state.encounters = normalized.encounters;
      state.duplicatesRemoved = normalized.duplicatesRemoved;
      state.accountConflicts = normalized.conflicts;

      if (!UR.validators.validateNormalized(state.encounters, diag)) {
        state.blocked = true;
        return state;
      }

      state.manualObservationsApplied = [];
      if (opts.manualObservations && opts.manualObservations.length) {
        applyManualObservations(state, opts.manualObservations, config, diag);
      }

      /* --------------------------------------------------- reporting period */
      var span = scope.dataSpan(state.encounters);
      var suggested = scope.inferReportingPeriod(state.encounters, config);
      state.dataSpan = span;
      state.suggestedPeriod = suggested;
      state.inferredPeriod = suggested ? suggested.period : span;

      if (opts.periodStart && opts.periodEnd) {
        if (opts.periodEnd.getTime() < opts.periodStart.getTime()) {
          /* A reversed range would make every figure silently zero. */
          diag.add('DQ_PERIOD_REVERSED', {
            message: 'The chosen reporting period ends (' + util.fmtDate(opts.periodEnd) +
                     ') before it starts (' + util.fmtDate(opts.periodStart) + '). Swap the dates and reprocess.'
          });
          state.blocked = true;
          return state;
        }
        state.period = scope.makePeriod(opts.periodStart, opts.periodEnd, opts.asOf);
        state.periodSource = 'Chosen by user';
      } else if (suggested) {
        state.period = suggested.period;
        state.periodSource = 'Inferred from the imported data';
        if (suggested.droppedMonths.length) {
          diag.add('DQ_OUT_OF_PERIOD', {
            message: 'The imported data touches ' + suggested.activity.keys.length + ' calendar month(s) (' +
              util.monthLabel(suggested.activity.keys[0]) + ' to ' +
              util.monthLabel(suggested.activity.keys[suggested.activity.keys.length - 1]) +
              '), but activity concentrates in ' + suggested.keptMonths.map(util.monthLabel).join(', ') +
              '. The reporting period defaulted to those month(s); ' +
              suggested.droppedMonths.map(util.monthLabel).join(', ') +
              ' contributed too few records to be part of the period and is treated as prior context. ' +
              'Set the dates explicitly if that is wrong.'
          });
        }
      } else {
        diag.add('DQ_DATE_COLUMN', { message: 'No usable admission datetime exists, so a reporting period cannot be established.' });
        state.blocked = true;
        return state;
      }
      if (!state.period.asOf) { state.period.asOf = state.period.endExclusiveDT; }

      /*
       * The as-of datetime bounds open encounters. Default it to the latest
       * activity in the data, capped at the end of the period, so occupancy is
       * never projected past what the export can support.
       */
      if (!opts.asOf && span) {
        var latest = span.asOf;
        state.period.asOf = latest.getTime() < state.period.endExclusiveDT.getTime() ? latest : state.period.endExclusiveDT;
      }

      UR.validators.reportOutOfPeriod(state.encounters, state.period, diag);

      /* ------------------------------------------ transitions and episodes */
      var linked = UR.transitionLinker.linkTransitions(state.encounters, config, diag);
      state.transitions = linked.transitions;

      var built = UR.episodeBuilder.buildEpisodes(state.encounters, diag);
      state.episodes = built.episodes;
      state.episodesById = built.byId;

      state.readmissions = UR.readmissionDetector.detect(state.episodes, config, diag);

      /* ----------------------------------------------------------- metrics */
      state.metrics = calculateAll(state.encounters, state.transitions, state.episodes, config, state.period);

      state.transitionCounts = {
        osip: state.metrics.observation.OSIP_001.value,
        ipsb: state.metrics.swingBed.IPSB_001.value,
        ossb: state.metrics.swingBed.OSSB_001.value,
        sbip: state.metrics.swingBed.SBIP_001.value
      };

      /*
       * Monthly trend series: one row per calendar month of the REPORTING
       * PERIOD, clamped to it. Months that only appear because a long stay
       * reaches back into them are context, not reporting months.
       */
      var months = scope.monthsIn(state.period);
      for (var m = 0; m < months.length; m++) {
        state.monthly.push({
          key: months[m].key,
          label: months[m].label,
          partial: months[m].partial,
          period: months[m].period,
          metrics: calculateAll(state.encounters, state.transitions, state.episodes, config, months[m].period),
          /* Attributed to the month the readmitting episode began. */
          readmissions: pipeline.readmissionsInPeriod(state, months[m].period)
        });
      }

      /* ------------------------------------------ inventory and review queue */
      state.codeInventory = UR.codeInventory.build(state.encounters, config, state.mapping);

      state.reviewQueue = UR.reviewQueue.build({
        encounters: state.encounters,
        transitions: state.transitions,
        episodes: state.episodes,
        readmissions: state.readmissions,
        metrics: state.metrics,
        config: config,
        period: state.period,
        diagnostics: diag
      });

      state.summaryLines = UR.validators.summaryLines(state);
      state.counts = UR.validators.summarize(state);

      return state;
    },

    /* Readmission pair counts whose new admission falls inside a period. */
    readmissionsInPeriod: function (state, period) {
      var windows = state.config.thresholds.readmissionWindowDays;
      var out = { short: 0, long: 0, medicare: 0 };
      var pairs = state.readmissions.pairs;
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (!scope.inPeriod(p.newEpisodeStart, period)) { continue; }
        if (p.within[String(windows[0])]) { out.short++; }
        if (p.within[String(windows[1])]) {
          out.long++;
          if (p.isMedicare) { out.medicare++; }
        }
      }
      return out;
    }
  };

  UR.pipeline = pipeline;

})(typeof globalThis !== 'undefined' ? globalThis : this);

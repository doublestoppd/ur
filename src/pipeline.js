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
     * options: { periodStart, periodEnd, asOf }
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

      var normalized = UR.normalizeEncounter.normalizeAll(sources, config, diag);
      state.encounters = normalized.encounters;
      state.duplicatesRemoved = normalized.duplicatesRemoved;
      state.accountConflicts = normalized.conflicts;

      if (!UR.validators.validateNormalized(state.encounters, diag)) {
        state.blocked = true;
        return state;
      }

      /* --------------------------------------------------- reporting period */
      var span = scope.dataSpan(state.encounters);
      var suggested = scope.inferReportingPeriod(state.encounters, config);
      state.dataSpan = span;
      state.suggestedPeriod = suggested;
      state.inferredPeriod = suggested ? suggested.period : span;

      if (opts.periodStart && opts.periodEnd) {
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

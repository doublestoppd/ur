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

  /* Distinct months spanned by the included admissions, oldest first. */
  function monthKeys(encounters) {
    var seen = {};
    var keys = [];
    for (var i = 0; i < encounters.length; i++) {
      var e = encounters[i];
      if (!e.metricEligible || !e.admitDT) { continue; }
      var k = util.monthKey(e.admitDT);
      if (!seen[k]) { seen[k] = e.admitDT; keys.push(k); }
    }
    keys.sort();
    var out = [];
    for (var j = 0; j < keys.length; j++) { out.push({ key: keys[j], sample: seen[keys[j]] }); }
    return out;
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
      var inferred = scope.inferPeriod(state.encounters);
      if (opts.periodStart && opts.periodEnd) {
        state.period = scope.makePeriod(opts.periodStart, opts.periodEnd, opts.asOf);
      } else if (inferred) {
        state.period = inferred;
      } else {
        diag.add('DQ_DATE_COLUMN', { message: 'No usable admission datetime exists, so a reporting period cannot be established.' });
        state.blocked = true;
        return state;
      }
      state.inferredPeriod = inferred;
      if (!state.period.asOf) { state.period.asOf = state.period.endExclusiveDT; }

      /*
       * The as-of datetime bounds open encounters. Default it to the latest
       * activity in the data, capped at the end of the period, so occupancy is
       * never projected past what the export can support.
       */
      if (!opts.asOf && inferred) {
        var latest = inferred.asOf;
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

      /* --------------------------------------------- monthly trend series */
      var months = monthKeys(state.encounters);
      for (var m = 0; m < months.length; m++) {
        var mPeriod = scope.monthPeriod(months[m].sample);
        if (mPeriod.asOf.getTime() > state.period.asOf.getTime()) { mPeriod.asOf = state.period.asOf; }
        state.monthly.push({
          key: months[m].key,
          label: util.monthLabel(months[m].key),
          period: mPeriod,
          metrics: calculateAll(state.encounters, state.transitions, state.episodes, config, mPeriod),
          /* Attributed to the month the readmitting episode began. */
          readmissions: pipeline.readmissionsInPeriod(state, mPeriod)
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

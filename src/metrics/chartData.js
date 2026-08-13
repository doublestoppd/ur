/*
 * chartData.js - shapes calculated metrics into chart specifications.
 *
 * Deliberately free of any drawing code so the shaping is unit-testable: the
 * renderer in src/ui/charts.js consumes these specs and knows nothing about
 * utilization review.
 *
 * Every spec names the Rule IDs behind it, so a chart can be traced back to the
 * Calculation Reference exactly like a number in the workbook.
 *
 * Form is chosen by the job the data does:
 *   line        - change over time
 *   bar         - magnitude across an ordered set (distribution bands, counts)
 *   groupedBar  - magnitude with a second identity dimension
 *   hbar        - magnitude across named categories with long labels, in the
 *                 order the underlying metric or registry already establishes
 * Series colours are assigned by identity in fixed slot order; a single-measure
 * chart uses one colour, because there is no identity to encode.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  function round(v, places) {
    return v === null || v === undefined ? null : util.round(v, places);
  }

  var chartData = {

    /*
     * Axis ticks on 1/2/5 x 10^n steps, always including zero. Pure arithmetic,
     * kept here rather than in the renderer so it can be unit-tested.
     */
    niceTicks: function (max, min, targetCount) {
      var lo = Math.min(0, min === undefined || min === null ? 0 : min);
      var hi = max <= lo ? lo + 1 : max;
      var span = hi - lo;
      var rough = span / (targetCount || 5);
      var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
      var norm = rough / mag;
      var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
      var start = Math.floor(lo / step) * step;
      var end = Math.ceil(hi / step) * step;
      var ticks = [];
      for (var v = start; v <= end + step / 1000; v += step) {
        ticks.push(Math.abs(v) < step / 1000 ? 0 : v);
      }
      return { ticks: ticks, min: start, max: end };
    },

    /*
     * Midnight census across the reporting period (PD_MN_001). A single-month
     * period plots every day; a longer period would be an unreadable comb of
     * daily points, so it aggregates to the average midnight census per month
     * (the ADC) instead - same underlying data, one point per month.
     */
    dailyCensus: function (state) {
      var daily = state.metrics.census.PD_MN_001.dailyCensus;
      var categories = [];
      var axisLabels = [];
      var ip = [], os = [], sb = [];
      var i;

      var months = UR.scope.monthsIn(state.period);
      if (months.length > 1) {
        var byKey = {};
        var order = [];
        for (i = 0; i < daily.length; i++) {
          var k = util.monthKey(daily[i].date);
          if (!byKey[k]) { byKey[k] = { n: 0, IP: 0, OS: 0, SB: 0 }; order.push(k); }
          byKey[k].n++;
          byKey[k].IP += daily[i].IP;
          byKey[k].OS += daily[i].OS;
          byKey[k].SB += daily[i].SB;
        }
        for (i = 0; i < order.length; i++) {
          var g = byKey[order[i]];
          categories.push(util.monthLabel(order[i]));
          ip.push(round(g.IP / g.n, 1));
          os.push(round(g.OS / g.n, 1));
          sb.push(round(g.SB / g.n, 1));
        }
        return {
          id: 'daily-census',
          title: 'Average midnight census by month',
          subtitle: 'Mean patients occupying a bed at local midnight, averaged over each month\'s days in the period. The per-day line is shown when the period is a single month.',
          ruleIds: ['PD_MN_001', 'ADC_MN_001'],
          form: 'line',
          categories: categories,
          series: [
            { name: 'Acute inpatient', values: ip },
            { name: 'Observation', values: os },
            { name: 'Swing bed', values: sb }
          ],
          valueLabel: 'Patients',
          decimals: 1,
          empty: daily.length ? '' : 'The reporting period contains no days.'
        };
      }

      for (i = 0; i < daily.length; i++) {
        categories.push(util.fmtDate(daily[i].date));
        /* The axis is dense, so it drops the year; tooltips and the table keep it. */
        axisLabels.push(util.pad2(daily[i].date.getUTCMonth() + 1) + '/' + util.pad2(daily[i].date.getUTCDate()));
        ip.push(daily[i].IP);
        os.push(daily[i].OS);
        sb.push(daily[i].SB);
      }
      return {
        id: 'daily-census',
        title: 'Midnight census by day',
        subtitle: 'Patients occupying a bed at each local midnight, by service.',
        ruleIds: ['PD_MN_001'],
        form: 'line',
        categories: categories,
        axisLabels: axisLabels,
        series: [
          { name: 'Acute inpatient', values: ip },
          { name: 'Observation', values: os },
          { name: 'Swing bed', values: sb }
        ],
        valueLabel: 'Patients',
        decimals: 0,
        empty: daily.length ? '' : 'The reporting period contains no days.'
      };
    },

    /* Admissions by service, per calendar month (IP/OS/SB _ADM_001). */
    monthlyAdmissions: function (state) {
      var categories = [], ip = [], os = [], sb = [];
      for (var i = 0; i < state.monthly.length; i++) {
        var m = state.monthly[i];
        categories.push(m.label);
        ip.push(m.metrics.inpatient.IP_ADM_001.value);
        os.push(m.metrics.observation.OS_ADM_001.value);
        sb.push(m.metrics.swingBed.SB_ADM_001.value);
      }
      return {
        id: 'monthly-admissions',
        title: 'Admissions by service and month',
        subtitle: 'Service-account counts. Internal status changes are counted in each service they touch; compare with episodes.',
        ruleIds: ['IP_ADM_001', 'OS_ADM_001', 'SB_ADM_001'],
        form: 'groupedBar',
        categories: categories,
        series: [
          { name: 'Acute inpatient', values: ip },
          { name: 'Observation', values: os },
          { name: 'Swing bed', values: sb }
        ],
        valueLabel: 'Admissions',
        decimals: 0,
        empty: categories.length ? '' : 'No month could be derived from the imported data.'
      };
    },

    /* Service accounts against continuous episodes, per month. */
    monthlyVolume: function (state) {
      var categories = [], accounts = [], episodes = [];
      for (var i = 0; i < state.monthly.length; i++) {
        var m = state.monthly[i];
        categories.push(m.label);
        accounts.push(m.metrics.census.ADM_SVC_001.value);
        episodes.push(m.metrics.census.EPISODE_CNT_001.value);
      }
      return {
        id: 'monthly-volume',
        title: 'Service accounts against continuous episodes',
        subtitle: 'The gap between the two is internal status changes. Episodes are the recommended headline count.',
        ruleIds: ['ADM_SVC_001', 'EPISODE_CNT_001'],
        form: 'groupedBar',
        categories: categories,
        series: [
          { name: 'Service accounts', values: accounts },
          { name: 'Continuous episodes', values: episodes }
        ],
        valueLabel: 'Count',
        decimals: 0,
        empty: categories.length ? '' : 'No month could be derived from the imported data.'
      };
    },

    /* Mean acute LOS per month against the CAH target (IP_TARGET_001). */
    monthlyAcuteLos: function (state) {
      var categories = [], mean = [], median = [];
      for (var i = 0; i < state.monthly.length; i++) {
        var m = state.monthly[i];
        categories.push(m.label);
        mean.push(round(m.metrics.inpatient.IP_ALOS_001.hours, 2));
        median.push(round(m.metrics.inpatient.IP_MEDLOS_001.hours, 2));
      }
      /* The reference line is IP_TARGET_001's day target, drawn in hours on
       * this hours axis, so the chart and the variance always agree. */
      var targetDays = state.config.thresholds.acuteTargetDays;
      return {
        id: 'monthly-acute-los',
        title: 'Acute inpatient length of stay by month',
        subtitle: 'Surveillance estimate only: the Critical Access Hospital requirement is an ANNUAL average, and swing-bed days are excluded from it.',
        ruleIds: ['IP_ALOS_001', 'IP_MEDLOS_001', 'IP_TARGET_001'],
        form: 'line',
        categories: categories,
        series: [
          { name: 'Mean LOS', values: mean },
          { name: 'Median LOS', values: median }
        ],
        reference: { value: targetDays * 24, label: targetDays + '-day (' + (targetDays * 24) + '-hour) CAH annual average' },
        valueLabel: 'Hours',
        decimals: 1,
        empty: categories.length ? '' : 'No month could be derived from the imported data.'
      };
    },

    /* Acute inpatient LOS distribution bands (LOSDIST_001). */
    losDistribution: function (state) {
      var dist = state.metrics.inpatient.LOSDIST_001;
      var categories = [], values = [];
      for (var i = 0; i < dist.bands.length; i++) {
        categories.push(dist.bands[i].label);
        values.push(dist.bands[i].count);
      }
      return {
        id: 'los-distribution',
        title: 'Acute inpatient length-of-stay distribution',
        subtitle: 'Discharged inpatient accounts in the period. Band boundaries are hour-based, so they agree exactly with the long-stay count.',
        ruleIds: ['LOSDIST_001', 'IP_GT4_001'],
        form: 'bar',
        categories: categories,
        series: [{ name: 'Discharged IP accounts', values: values }],
        valueLabel: 'Accounts',
        decimals: 0,
        empty: dist.n ? '' : 'No discharged inpatient account qualified for this period.'
      };
    },

    /*
     * Observation duration bands. The threshold METRICS are nested (a 50-hour
     * stay counts in >24, >36, and >48); a distribution has to be exclusive, so
     * these bands are cut from the same thresholds and will not match the
     * metric counts directly. That is stated in the subtitle.
     */
    observationBands: function (state) {
      var thresholds = state.config.thresholds.obsThresholdHours;
      var encounters = state.metrics.observation.OS_LOS_001.encounters;
      var edges = [0].concat(thresholds);
      var categories = [];
      var values = [];
      var i, e;

      for (i = 0; i < edges.length; i++) {
        var lo = edges[i];
        var hi = i + 1 < edges.length ? edges[i + 1] : null;
        categories.push(hi === null ? '> ' + lo + 'h' : (i === 0 ? '<= ' + hi + 'h' : '> ' + lo + ' - ' + hi + 'h'));
        values.push(0);
      }
      for (i = 0; i < encounters.length; i++) {
        e = encounters[i];
        var band = 0;
        for (var b = 0; b < thresholds.length; b++) {
          if (e.durationHours > thresholds[b]) { band = b + 1; }
        }
        values[band]++;
      }
      return {
        id: 'observation-bands',
        title: 'Observation duration distribution',
        subtitle: 'Exclusive bands, so each account appears once. The OS_24/36/48 metrics are cumulative and will read higher.',
        ruleIds: ['OS_LOS_001', 'OS_24_001', 'OS_36_001', 'OS_48_001'],
        form: 'bar',
        categories: categories,
        series: [{ name: 'Discharged observation accounts', values: values }],
        valueLabel: 'Accounts',
        decimals: 0,
        empty: encounters.length ? '' : 'No discharged observation account qualified for this period.'
      };
    },

    /* Payer mix by mapped category (PAYER_MIX_001). */
    payerMix: function (state) {
      var rows = state.metrics.payer.PAYER_MIX_001.byCategory;
      var categories = [], values = [];
      for (var i = 0; i < rows.length; i++) {
        categories.push(rows[i].key);
        values.push(rows[i].accounts);
      }
      return {
        id: 'payer-mix',
        title: 'Payer mix',
        subtitle: 'Service accounts admitted in the period, by mapped payer category. Unmapped insurance codes group under Unknown.',
        ruleIds: ['PAYER_MIX_001'],
        form: 'hbar',
        categories: categories,
        series: [{ name: 'Service accounts', values: values }],
        valueLabel: 'Accounts',
        decimals: 0,
        empty: rows.length ? '' : 'No payer data for this period.'
      };
    },

    /* Discharge disposition distribution (DISPO_001). */
    disposition: function (state) {
      var rows = state.metrics.payer.DISPO_001.rows;
      var categories = [], values = [];
      for (var i = 0; i < rows.length; i++) {
        categories.push(rows[i].category);
        values.push(rows[i].count);
      }
      return {
        id: 'disposition',
        title: 'Discharge disposition',
        subtitle: 'Mapped discharge-code categories for discharges in the period. Internal transition codes appear as their own category and are not patient dispositions.',
        ruleIds: ['DISPO_001', 'DEATH_001'],
        form: 'hbar',
        categories: categories,
        series: [{ name: 'Discharges', values: values }],
        valueLabel: 'Discharges',
        decimals: 0,
        empty: rows.length ? '' : 'No discharge occurred in this period.'
      };
    },

    /* Admissions and discharges by weekday (DOW_001). */
    dayOfWeek: function (state) {
      var dow = state.metrics.payer.DOW_001;
      return {
        id: 'day-of-week',
        title: 'Admissions and discharges by day of week',
        subtitle: 'Objective operational trend. No staffing or appropriateness conclusion is implied.',
        ruleIds: ['DOW_001'],
        form: 'groupedBar',
        categories: dow.dayNames.slice(),
        series: [
          { name: 'Admissions', values: dow.admits.slice() },
          { name: 'Discharges', values: dow.discharges.slice() }
        ],
        valueLabel: 'Count',
        decimals: 0,
        empty: ''
      };
    },

    /* Admission source, when the column was mapped (ADMSRC_001). */
    admissionSource: function (state) {
      var src = state.metrics.payer.ADMSRC_001;
      var categories = [], values = [];
      for (var i = 0; i < src.rows.length; i++) {
        categories.push(src.rows[i].label || src.rows[i].code);
        values.push(src.rows[i].count);
      }
      return {
        id: 'admission-source',
        title: 'Admission source',
        subtitle: 'Mapped admission-source values for included admissions in the period.',
        ruleIds: ['ADMSRC_001'],
        form: 'hbar',
        categories: categories,
        series: [{ name: 'Admissions', values: values }],
        valueLabel: 'Admissions',
        decimals: 0,
        empty: src.available ? '' : 'No admission-source column was mapped for this run.'
      };
    },

    /* Internal status transitions actually reconstructed (TRANS_001). */
    transitions: function (state) {
      var t = state.transitionCounts;
      return {
        id: 'transitions',
        title: 'Internal status transitions',
        subtitle: 'Accepted links only. Ambiguous candidates and missing successors are deliberately excluded and appear in the review queue instead.',
        ruleIds: ['OSIP_001', 'IPSB_001', 'SBIP_001', 'OSSB_001'],
        form: 'bar',
        categories: ['OS to IP', 'IP to SB', 'SB to IP', 'OS to SB'],
        series: [{ name: 'Accepted transitions', values: [t.osip, t.ipsb, t.sbip, t.ossb] }],
        valueLabel: 'Transitions',
        decimals: 0,
        empty: ''
      };
    },

    /* Readmission indicators by month. */
    readmissions: function (state) {
      var windows = state.config.thresholds.readmissionWindowDays;
      var categories = [], shortW = [], longW = [];
      for (var i = 0; i < state.monthly.length; i++) {
        categories.push(state.monthly[i].label);
        shortW.push(state.monthly[i].readmissions.short);
        longW.push(state.monthly[i].readmissions.long);
      }
      return {
        id: 'readmissions',
        title: 'Readmission indicators by month',
        subtitle: 'INTERNAL OPERATIONAL INDICATORS. Not CMS risk-standardized measures: no risk adjustment, no planned-readmission algorithm, and no visibility of other facilities.',
        ruleIds: ['READMIT_7_001', 'READMIT_30_001'],
        form: 'groupedBar',
        categories: categories,
        series: [
          { name: 'Within ' + windows[0] + ' days', values: shortW },
          { name: 'Within ' + windows[1] + ' days', values: longW }
        ],
        valueLabel: 'Readmissions',
        decimals: 0,
        empty: categories.length ? '' : 'No month could be derived from the imported data.'
      };
    },

    /* Review queue volume by trigger. */
    reviewQueue: function (state) {
      var ids = UR.reviewRules.ids();
      var categories = [], values = [];
      for (var i = 0; i < ids.length; i++) {
        var count = state.reviewQueue.counts[ids[i]] || 0;
        if (!count) { continue; }
        categories.push(UR.reviewRules.byId(ids[i]).name);
        values.push(count);
      }
      return {
        id: 'review-queue',
        title: 'Review queue by trigger',
        subtitle: 'Accounts identified for human review. No row expresses a clinical, medical-necessity, denial, or compliance conclusion.',
        ruleIds: ids,
        form: 'hbar',
        categories: categories,
        series: [{ name: 'Review rows', values: values }],
        valueLabel: 'Rows',
        decimals: 0,
        empty: categories.length ? '' : 'No account met a review trigger for this period.'
      };
    },

    /* Diagnostics by severity, drawn with the reserved status colours. */
    dataQuality: function (state) {
      var counts = state.diagnostics.counts();
      var categories = [], values = [];
      for (var i = 0; i < UR.SEVERITY_ORDER.length; i++) {
        categories.push(UR.SEVERITY_ORDER[i]);
        values.push(counts[UR.SEVERITY_ORDER[i]] || 0);
      }
      return {
        id: 'data-quality',
        title: 'Diagnostics by severity',
        subtitle: 'Every finding is listed on the Data Quality worksheet with the affected accounts.',
        ruleIds: [],
        form: 'bar',
        palette: 'status',
        categories: categories,
        series: [{ name: 'Findings', values: values }],
        valueLabel: 'Findings',
        decimals: 0,
        empty: ''
      };
    },

    /*
     * Every chart for the current run, in reading order. Charts whose data is
     * unavailable still appear, carrying the reason rather than vanishing.
     */
    all: function (state) {
      return [
        chartData.dailyCensus(state),
        chartData.monthlyAdmissions(state),
        chartData.monthlyVolume(state),
        chartData.monthlyAcuteLos(state),
        chartData.losDistribution(state),
        chartData.observationBands(state),
        chartData.transitions(state),
        chartData.readmissions(state),
        chartData.payerMix(state),
        chartData.disposition(state),
        chartData.admissionSource(state),
        chartData.dayOfWeek(state),
        chartData.reviewQueue(state),
        chartData.dataQuality(state)
      ];
    },

    /* Rows for a chart's accessible table view. */
    toTable: function (spec) {
      var header = [spec.form === 'hbar' ? 'Category' : 'Period'].concat(
        spec.series.map(function (s) { return s.name; }));
      var rows = [];
      for (var i = 0; i < spec.categories.length; i++) {
        var row = [spec.categories[i]];
        for (var s = 0; s < spec.series.length; s++) {
          var v = spec.series[s].values[i];
          row.push(v === null || v === undefined ? '' : v);
        }
        rows.push(row);
      }
      return { header: header, rows: rows };
    }
  };

  UR.chartData = chartData;

})(typeof globalThis !== 'undefined' ? globalThis : this);

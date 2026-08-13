/*
 * Chart data shaping.
 *
 * The renderer is DOM code and is exercised in the browser; what is tested here
 * is that every chart is built from the calculated metrics, agrees with the
 * numbers reported elsewhere, and carries the Rule IDs behind it.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);
var specs = UR.chartData.all(state);

function spec(id) {
  for (var i = 0; i < specs.length; i++) { if (specs[i].id === id) { return specs[i]; } }
  return null;
}

describe('chart specifications', function () {

  test('every chart is well formed', function () {
    assert.ok(specs.length >= 12, 'the run produces a full set of graphs');
    var seen = {};
    specs.forEach(function (s) {
      assert.ok(s.id, 'chart has an id');
      assert.notOk(seen[s.id], 'duplicate chart id ' + s.id);
      seen[s.id] = true;
      assert.ok(s.title, s.id + ' has a title');
      assert.ok(s.subtitle && s.subtitle.length > 15, s.id + ' explains itself');
      assert.ok(UR.util.contains(['line', 'bar', 'groupedBar', 'hbar'], s.form), s.id + ' form: ' + s.form);
      assert.ok(s.series.length >= 1, s.id + ' has at least one series');
      s.series.forEach(function (series) {
        assert.ok(series.name, s.id + ' series has a name');
        assert.equal(series.values.length, s.categories.length,
          s.id + ' series "' + series.name + '" has one value per category');
      });
    });
  });

  test('every cited Rule ID exists in a registry', function () {
    specs.forEach(function (s) {
      (s.ruleIds || []).forEach(function (id) {
        assert.ok(UR.calculationRules.byId(id) || UR.reviewRules.byId(id),
          s.id + ' cites unknown rule ' + id);
      });
    });
  });

  test('a chart with no data explains itself instead of drawing nothing', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [21, 'G1', 'GRAPH, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', '']
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var charts = UR.chartData.all(s);
    var source = charts.filter(function (c) { return c.id === 'admission-source'; })[0];
    assert.includes(source.empty, 'No admission-source column was mapped');
  });

  test('the census chart matches the midnight patient-day total', function () {
    var s = spec('daily-census');
    assert.equal(s.categories.length, state.period.days);
    var total = 0;
    for (var i = 0; i < s.categories.length; i++) {
      total += s.series[0].values[i] + s.series[1].values[i] + s.series[2].values[i];
    }
    assert.equal(total, state.metrics.census.PD_MN_001.value,
      'the daily series sums to PD_MN_001');
  });

  test('monthly admissions match the monthly metrics', function () {
    var s = spec('monthly-admissions');
    assert.equal(s.categories.length, state.monthly.length);
    assert.equal(s.series[0].values[0], state.monthly[0].metrics.inpatient.IP_ADM_001.value);
    assert.equal(s.series[1].values[0], state.monthly[0].metrics.observation.OS_ADM_001.value);
    assert.equal(s.series[2].values[0], state.monthly[0].metrics.swingBed.SB_ADM_001.value);
  });

  test('the acute LOS chart carries the CAH target as a reference line', function () {
    var s = spec('monthly-acute-los');
    /* The chart draws acuteTargetDays * 24 so it always agrees with
     * IP_TARGET_001's variance, even if acuteTargetHours is configured
     * independently. */
    assert.equal(s.reference.value, state.config.thresholds.acuteTargetDays * 24);
    assert.includes(s.reference.label, 'annual average');
    assert.includes(s.subtitle, 'ANNUAL');
  });

  test('the LOS distribution matches the metric bands', function () {
    var s = spec('los-distribution');
    var bands = state.metrics.inpatient.LOSDIST_001.bands;
    assert.equal(s.categories.length, bands.length);
    for (var i = 0; i < bands.length; i++) {
      assert.equal(s.series[0].values[i], bands[i].count, bands[i].label);
    }
  });

  test('observation bands are exclusive and account for every qualifying stay', function () {
    var s = spec('observation-bands');
    var total = 0;
    s.series[0].values.forEach(function (v) { total += v; });
    assert.equal(total, state.metrics.observation.OS_LOS_001.n,
      'each discharged observation account lands in exactly one band');
    assert.includes(s.subtitle, 'cumulative', 'the difference from OS_24/36/48 is stated');

    /* The top band is the same population as the cumulative >48h metric. */
    assert.equal(s.series[0].values[s.series[0].values.length - 1],
      state.metrics.observation.OS_48_001.value);
  });

  test('payer mix and disposition match their metrics', function () {
    var payer = spec('payer-mix');
    var rows = state.metrics.payer.PAYER_MIX_001.byCategory;
    assert.equal(payer.categories.length, rows.length);
    assert.equal(payer.series[0].values[0], rows[0].accounts);

    var dispo = spec('disposition');
    assert.equal(dispo.categories.length, state.metrics.payer.DISPO_001.rows.length);
  });

  test('the transitions chart matches the accepted link counts', function () {
    var s = spec('transitions');
    assert.deepEqual(s.series[0].values, [
      state.transitionCounts.osip,
      state.transitionCounts.ipsb,
      state.transitionCounts.sbip,
      state.transitionCounts.ossb
    ]);
  });

  test('the review-queue chart matches the queue counts', function () {
    var s = spec('review-queue');
    var total = 0;
    s.series[0].values.forEach(function (v) { total += v; });
    var expected = 0;
    UR.reviewRules.ids().forEach(function (id) { expected += state.reviewQueue.counts[id] || 0; });
    assert.equal(total, expected);
    assert.equal(total, state.reviewQueue.rows.length);
  });

  test('the diagnostics chart uses the severity ladder and the status palette', function () {
    var s = spec('data-quality');
    assert.deepEqual(s.categories, UR.SEVERITY_ORDER);
    assert.equal(s.palette, 'status', 'severity is a status encoding, not a series identity');
    var counts = state.diagnostics.counts();
    assert.equal(s.series[0].values[0], counts.Blocking);
    assert.equal(s.series[0].values[2], counts.Warning);
  });

  test('the readmission chart refuses the CMS label', function () {
    var s = spec('readmissions');
    assert.includes(s.subtitle, 'INTERNAL OPERATIONAL INDICATORS');
    assert.includes(s.subtitle, 'Not CMS');
  });

  test('no chart asserts a clinical conclusion', function () {
    var forbidden = ['medically necessary', 'inappropriate', 'denied', 'non-compliant', 'avoidable'];
    specs.forEach(function (s) {
      var text = (s.title + ' ' + s.subtitle).toLowerCase();
      forbidden.forEach(function (phrase) {
        assert.ok(text.indexOf(phrase) < 0, s.id + ' must not assert "' + phrase + '"');
      });
    });
  });

  test('every chart converts to an accessible data table', function () {
    specs.forEach(function (s) {
      var t = UR.chartData.toTable(s);
      assert.equal(t.header.length, s.series.length + 1, s.id + ' table header');
      assert.equal(t.rows.length, s.categories.length, s.id + ' table rows');
    });
  });
});

describe('chart scales', function () {

  test('axis ticks are round numbers spanning the data', function () {
    var t = UR.chartData.niceTicks(37, 0, 5);
    assert.equal(t.min, 0, 'the scale always includes zero');
    assert.ok(t.max >= 37, 'and covers the largest value');
    assert.ok(t.ticks.length >= 3 && t.ticks.length <= 12);
    var step = t.ticks[1] - t.ticks[0];
    var mantissa = step / Math.pow(10, Math.floor(Math.log(step) / Math.LN10));
    assert.ok([1, 2, 5, 10].indexOf(Math.round(mantissa * 100) / 100) >= 0,
      'steps are 1, 2, or 5 times a power of ten (got ' + step + ')');
  });

  test('an all-zero series still produces a usable scale', function () {
    var t = UR.chartData.niceTicks(0, 0, 5);
    assert.ok(t.max > 0, 'the axis does not collapse');
    assert.equal(t.min, 0);
  });

  test('fractional data gets a fractional scale', function () {
    var t = UR.chartData.niceTicks(2.4, 0, 5);
    assert.ok(t.max >= 2.4 && t.max <= 5, 'the scale is not inflated to a whole number');
  });
});

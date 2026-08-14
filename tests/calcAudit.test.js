/*
 * Regression tests for the calculation audit: every fix here traces to a
 * verified finding (boundary consistency, date/time parsing, review-list
 * gating, readmission index selection, linker cycles).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

describe('military time 2400', function () {

  test('a 2400 discharge means midnight ending that date, not starting it', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [50, 'M1', 'MIL, TEST', 'IP', '08/01/2026', 1000, '08/03/2026', 2400, 'BCBS', 'H', 1]
    ]});
    var e = s.encounters[0];
    assert.equal(e.dischargeDT.toISOString(), '2026-08-04T00:00:00.000Z');
    assert.close(e.durationHours, 62, 1e-9, '08/01 10:00 to 08/04 00:00');
    assert.equal(e.midnights, 3);
  });

  test('an admit-0800 discharge-2400 same-day stay is 16 hours, not excluded', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [52, 'M2', 'MILB, TEST', 'IP', '08/03/2026', 800, '08/03/2026', 2400, 'BCBS', 'H', 1]
    ]});
    var e = s.encounters[0];
    assert.ok(e.metricEligible, 'the row participates in metrics');
    assert.close(e.durationHours, 16, 1e-9);
  });
});

describe('zero and negative durations', function () {

  test('a zero-length stay is flagged and stays consistent across metrics', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [54, 'Z1', 'ZERO, TEST', 'IP', '08/10/2026', 1000, '08/10/2026', 1000, 'MCR', 'H', 1]
    ]});
    assert.ok(s.diagnostics.all().some(function (d) { return d.ruleId === 'DQ_ZERO_LOS'; }),
      'DQ_ZERO_LOS warning raised');
    assert.equal(s.metrics.inpatient.IP_SHORT_001.value, 0, 'not a one-day stay (positive duration required)');
    assert.equal(s.metrics.inpatient.LOSDIST_001.bands[0].count, 1, 'held by the lowest distribution band');
  });

  test('a clamped registration inversion reports zero midnights, never negative', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [56, 'N1', 'INVERT, TEST', 'IP', '08/04/2026', 0, '08/03/2026', 2350, 'MCR', 'H', 1]
    ]});
    var e = s.encounters.find(function (x) { return x.account === 'N1'; });
    assert.equal(e.durationHours, 0);
    assert.ok(e.durationClamped);
    assert.equal(e.midnights, 0, 'clamped stays are instantaneous, not negative');
  });

  test('a beyond-tolerance inversion says it is excluded from ALL figures', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [58, 'N2', 'FARINV, TEST', 'IP', '08/04/2026', 1200, '08/03/2026', 800, 'MCR', 'H', 1]
    ]});
    var d = s.diagnostics.all().find(function (x) { return x.ruleId === 'DQ_NEG_LOS'; });
    assert.ok(d && d.message.indexOf('ALL figures') >= 0, 'the diagnostic states the true exclusion breadth');
  });
});

describe('reversed reporting period', function () {

  test('an end date before the start blocks with a diagnostic instead of silent zeros', function () {
    var s = fixtures.run(UR, {
      periodStart: util.mkDT(2026, 8, 31, 0, 0),
      periodEnd: util.mkDT(2026, 8, 1, 0, 0)
    });
    assert.ok(s.blocked, 'processing stops');
    assert.ok(s.diagnostics.all().some(function (d) { return d.ruleId === 'DQ_PERIOD_REVERSED'; }));
  });
});

describe('conversion-rate boundary consistency', function () {

  test('a conversion at the exact period boundary always has a denominator seat', function () {
    /* OS discharges exactly at the period start midnight; the conversion
     * moment (IP admission) falls just inside the period. */
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [60, 'B1', 'BOUNDARY, TEST', 'OS', '07/31/2026', 900, '08/01/2026', 0, 'MCR', 'B', 1],
      [60, 'B2', 'BOUNDARY, TEST', 'IP', '08/01/2026', 30, '08/03/2026', 1000, 'MCR', 'H', 1]
    ]});
    var r = s.metrics.observation.OSIP_RATE_001;
    assert.equal(s.metrics.observation.OSIP_001.value, 1);
    assert.equal(r.numerator, 1);
    assert.equal(r.denominator, 1, 'the converting OS account joins the denominator');
    assert.close(r.value, 100, 1e-9);
  });
});

describe('review work-list gating', function () {

  test('a threshold-crossing OS stay reaching past the period end is on the RQ_OS lists', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [62, 'H1', 'CROSSEND, TEST', 'OS', '08/30/2026', 800, '09/01/2026', 1000, 'MCR', 'H', 1]
    ], periodStart: util.mkDT(2026, 8, 1, 0, 0), periodEnd: util.mkDT(2026, 8, 31, 0, 0),
       asOf: util.mkDT(2026, 9, 2, 0, 0) });
    function rows(id) { return s.reviewQueue.rows.filter(function (r) { return r.ruleId === id; }); }
    assert.ok(rows('RQ_OS_24').some(function (r) { return r.account === 'H1'; }), 'on the 24h list');
    assert.ok(rows('RQ_OS_48').some(function (r) { return r.account === 'H1'; }), 'on the 48h list');
    assert.equal(s.metrics.observation.OS_24_001.value, 0,
      'the COUNT metric stays anchored on the discharge date');
    var row = rows('RQ_OS_24').filter(function (r) { return r.account === 'H1'; })[0];
    assert.includes(row.detail, 'outside the discharged-stay COUNT metric');
  });

  test('a stay discharged exactly at the period start is still in work-list scope', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [64, 'I1', 'MIDDIS, TEST', 'IP', '07/20/2026', 800, '08/01/2026', '', 'MCR', 'H', 1]
    ]});
    var listed = UR.scope.inScopeOrCounted(s.encounters, UR.SERVICE.IP, fixtures.buildConfig(UR), s.period);
    assert.ok(listed.some(function (e) { return e.account === 'I1'; }),
      'counted in this period\'s discharged-stay figures, so in work-list scope');
  });
});

describe('payer-mix reconciliation', function () {

  test('per-payer long-stay counts reconcile with IP_GT4_001 at the period boundary', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [64, 'I1', 'MIDDIS, TEST', 'IP', '07/20/2026', 800, '08/01/2026', '', 'MCR', 'H', 1],
      [66, 'I2', 'CTRL, TEST', 'IP', '08/05/2026', 800, '08/10/2026', 900, 'MCR', 'H', 1]
    ]});
    var total = 0;
    s.metrics.payer.PAYER_MIX_001.byCategory.forEach(function (r) { total += r.longStays; });
    assert.equal(s.metrics.inpatient.IP_GT4_001.value, 2);
    assert.equal(total, 2, 'the payer columns account for every long stay');
  });
});

describe('readmission index selection', function () {

  function ipRow(age, acct, name, ad, at, dd, dt, code) {
    return [age, acct, name, 'IP', ad, at, dd, dt, 'MCR', code || 'H', 1];
  }

  test('an episode ended by a failed internal transition is never an index stay', function () {
    /* Q expects a swing-bed successor that is absent from the export. */
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      ipRow(68, 'R1', 'FAILEDQ, TEST', '08/02/2026', 800, '08/06/2026', 1500, 'Q'),
      ipRow(68, 'R2', 'FAILEDQ, TEST', '08/10/2026', 900, '08/12/2026', 900, 'H')
    ]});
    assert.equal(s.readmissions.pairs.length, 0,
      'a status change is not a discharge, so no readmission pair forms');
  });

  test('the index stay is the latest DISCHARGE, not the latest start', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      ipRow(70, 'P101', 'OVERLAP, TEST', '08/01/2026', 800, '08/20/2026', 1000, 'H'),
      ipRow(70, 'P102', 'OVERLAP, TEST', '08/02/2026', 900, '08/03/2026', 900, 'H'),
      ipRow(70, 'P103', 'OVERLAP, TEST', '08/25/2026', 1000, '08/28/2026', 900, 'H')
    ]});
    var pair = s.readmissions.pairs.filter(function (p) { return p.newIPAccount === 'P103'; })[0];
    assert.ok(pair, 'the readmission is detected');
    assert.includes(pair.priorAccounts, 'P101', 'measured from the 08/20 discharge');
    assert.ok(pair.daysBetween < 7, 'a 7-day readmission, not a 22-day one');
    assert.ok(pair.within['7']);
  });

  test('an admission after a death-ended episode is an identity warning, not a readmission', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      ipRow(72, 'D1', 'DECEASED, TEST', '08/02/2026', 800, '08/06/2026', 1500, 'E'),
      ipRow(72, 'D2', 'DECEASED, TEST', '08/10/2026', 900, '08/12/2026', 900, 'H')
    ]});
    assert.equal(s.readmissions.pairs.length, 0, 'no pair across a death');
    assert.ok(s.diagnostics.all().some(function (d) { return d.ruleId === 'DQ_POSTMORTEM_ADMIT'; }),
      'the identity conflict is diagnosed');
  });
});

describe('transition linker cycles', function () {

  test('two mutually overlapping accounts never form a cycle of accepted links', function () {
    /* SB 08:00-09:00 code V (expects IP); IP 08:30-08:50 code Q (expects SB).
     * Both admissions sit inside the other's overlap tolerance. */
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [74, 'C101', 'CYCLE, TEST', 'SB', '08/05/2026', 800, '08/05/2026', 900, 'MCR', 'V', 1],
      [74, 'C102', 'CYCLE, TEST', 'IP', '08/05/2026', 830, '08/05/2026', 850, 'MCR', 'Q', 1]
    ]});
    assert.equal(s.transitionCounts.sbip, 1, 'the genuine SB -> IP conversion links');
    assert.equal(s.transitionCounts.ipsb, 0, 'no fabricated reverse link');
    var episodes = s.episodes.filter(function (ep) { return ep.accounts.indexOf('C101') >= 0; });
    assert.equal(episodes.length, 1, 'one episode');
    assert.equal(episodes[0].accounts.length, 2, 'containing both accounts');
  });
});

describe('open stays and the as-of datetime', function () {

  test('an open stay admitted inside the period after the as-of still counts by its admission', function () {
    var s = fixtures.run(UR, { matrix: [
      fixtures.HEADERS.slice(),
      [76, 'O1', 'AFTER, TEST', 'IP', '08/20/2026', 900, '', '', 'BCBS', '', 1],
      [78, 'O2', 'CTRL, TEST', 'IP', '08/05/2026', 900, '08/07/2026', 900, 'BCBS', 'H', 1]
    ], asOf: util.mkDT(2026, 8, 15, 0, 0)});
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 2, 'the admission event is in the period');
    assert.equal(s.metrics.census.PATIENT_CNT_001.value, 2, 'patient count agrees with the admission count');
    var o1 = s.encounters.find(function (e) { return e.account === 'O1'; });
    assert.equal(UR.scope.inPeriodOccupancyHours(o1, s.period, s.config), 0,
      'while occupancy is measurable only through the as-of datetime');
  });

  test('an open stay admitted after the period never overlaps it', function () {
    var period = UR.scope.makePeriod(util.mkDT(2026, 7, 1, 0, 0), util.mkDT(2026, 7, 31, 0, 0),
      util.mkDT(2026, 7, 15, 0, 0));
    assert.ok(!UR.scope.overlapsPeriod({ admitDT: util.mkDT(2026, 8, 20, 9, 0), dischargeDT: null, isOpen: true }, period));
  });
});

describe('chart tick labels', function () {

  test('fractional tick steps carry enough decimals to stay distinct', function () {
    var scale = UR.chartData.niceTicks(1, 0, 4);
    assert.deepEqual(scale.ticks, [0, 0.5, 1]);
    var labels = scale.ticks.map(function (v) { return String(util.round(v, 1)); });
    assert.deepEqual(labels, ['0', '0.5', '1'], 'one decimal keeps 0.5 distinct from 1');
  });
});

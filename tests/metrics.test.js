/*
 * Metric calculations (spec 9, fixtures T13-T16).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);
var m = state.metrics;

function accountsFor(list) { return list.slice().sort().join(','); }

describe('inpatient metrics', function () {

  test('T13 counts a 121-hour stay as > 4 days with 25 excess hours', function () {
    var b001 = null;
    state.encounters.forEach(function (e) { if (e.account === 'B001') { b001 = e; } });
    assert.close(b001.durationHours, 121, 1e-9);
    assert.ok(m.inpatient.IP_GT4_001.accounts.indexOf('B001') >= 0, 'B001 is on the long-stay list');
    var excess = null;
    m.inpatient.IP_GT4_001.detail.forEach(function (d) { if (d.encounter.account === 'B001') { excess = d.excessDays; } });
    assert.close(excess, 25 / 24, 1e-9, '25 hours over the 96-hour target, expressed in days');
  });

  test('a stay of exactly 96 hours is not a long stay', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9101', 'E96', 'EXACT, TEST', 'IP', '08/01/2026', 800, '08/05/2026', 800, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.close(s.encounters[0].durationHours, 96, 1e-9);
    assert.equal(s.metrics.inpatient.IP_GT4_001.value, 0, 'the threshold is strictly greater than');
    assert.close(s.metrics.inpatient.IP_EXCESS_001.totalDays, 0, 1e-12);
  });

  test('mean and median acute LOS use only discharged IP segments', function () {
    var expected = [];
    state.encounters.forEach(function (e) {
      if (e.serviceClass === 'IP' && !e.isOpen && e.durationHours !== null && e.metricEligible &&
          UR.scope.inPeriod(e.dischargeDT, state.period)) {
        expected.push(e.durationHours);
      }
    });
    assert.equal(m.inpatient.IP_ALOS_001.n, expected.length);
    assert.close(m.inpatient.IP_ALOS_001.hours, util.mean(expected), 1e-9);
    assert.close(m.inpatient.IP_MEDLOS_001.hours, util.median(expected), 1e-9);
    assert.close(m.inpatient.IP_ALOS_001.days, m.inpatient.IP_ALOS_001.hours / 24, 1e-12);
  });

  test('swing-bed and observation time stay out of the acute average', function () {
    m.inpatient.IP_ALOS_001.accounts.forEach(function (acct) {
      var enc = null;
      state.encounters.forEach(function (e) { if (e.account === acct) { enc = e; } });
      assert.equal(enc.serviceClass, 'IP', acct + ' must be an inpatient account');
    });
  });

  test('the target variance carries both readings and labels itself an estimate', function () {
    assert.equal(m.inpatient.IP_TARGET_001.targetDays, 4);
    assert.close(m.inpatient.IP_TARGET_001.varianceDays, m.inpatient.IP_ALOS_001.days - 4, 1e-9);
    assert.close(m.inpatient.IP_TARGET_001.varianceHours, m.inpatient.IP_ALOS_001.hours - 96, 1e-9,
      'the hours reading equals the retired CAH96_001 arithmetic exactly');
    assert.equal(m.inpatient.IP_TARGET_001.withinTarget, m.inpatient.IP_ALOS_001.days <= 4);
    var rule = UR.calculationRules.byId('IP_TARGET_001');
    assert.equal(rule.version, '1.1');
    assert.equal(rule.classification, UR.CLASSIFICATION.REGULATORY);
    assert.includes(rule.notes, 'SURVEILLANCE ESTIMATE ONLY');
    assert.includes(rule.notes, 'ANNUAL');
    assert.includes(rule.notes, 'CAH96_001', 'the merge is documented in the registry');
    assert.equal(UR.calculationRules.byId('CAH96_001'), null, 'the duplicate rule is gone');
  });

  test('T14 flags a Medicare inpatient crossing a single midnight', function () {
    assert.ok(m.inpatient.IP_2MN_001.accounts.indexOf('B101') >= 0);
    var enc = null;
    state.encounters.forEach(function (e) { if (e.account === 'B101') { enc = e; } });
    assert.equal(enc.midnights, 1);
    assert.equal(enc.payerCategory, UR.PAYER_CATEGORY.MEDICARE_FFS);
  });

  test('one-day stays use elapsed hours and break down by payer', function () {
    var oneDay = m.inpatient.IP_SHORT_001;
    oneDay.encounters.forEach(function (e) {
      assert.ok(e.durationHours > 0 && e.durationHours <= 24, e.account + ' within 24 hours');
    });
    var total = 0;
    Object.keys(oneDay.byPayer).forEach(function (k) { total += oneDay.byPayer[k]; });
    assert.equal(total, oneDay.value, 'the payer breakdown sums to the total');
  });

  test('the LOS distribution bands agree with the long-stay count', function () {
    var dist = m.inpatient.LOSDIST_001;
    var total = 0;
    dist.bands.forEach(function (b) { total += b.count; });
    assert.equal(total, m.inpatient.IP_ALOS_001.n, 'every qualifying stay lands in exactly one band');
    var over4 = dist.bands[dist.bands.length - 1];
    assert.equal(over4.count, m.inpatient.IP_GT4_001.value, '> 4 day band matches IP_GT4_001');
  });
});

describe('observation metrics', function () {

  test('T15 puts a 31-hour Medicare observation past 24h but not past 36h', function () {
    var enc = null;
    state.encounters.forEach(function (e) { if (e.account === 'B201') { enc = e; } });
    assert.close(enc.durationHours, 31, 1e-9);
    assert.ok(m.observation.OS_24_001.accounts.indexOf('B201') >= 0, 'past 24 hours');
    assert.ok(m.observation.OS_36_001.accounts.indexOf('B201') < 0, 'not past 36 hours');
    assert.ok(m.observation.OS_48_001.accounts.indexOf('B201') < 0);

    var moon = state.reviewQueue.rows.filter(function (r) { return r.ruleId === 'RQ_MOON' && r.account === 'B201'; });
    assert.equal(moon.length, 1, 'and it is a MOON manual-check candidate');
    assert.equal(moon[0].past36, false);
  });

  test('the conversion rate documents its denominator and exclusions', function () {
    var rate = m.observation.OSIP_RATE_001;
    assert.equal(rate.numerator, m.observation.OSIP_001.value);
    assert.ok(rate.denominator > 0);
    assert.close(rate.value, (rate.numerator / rate.denominator) * 100, 1e-9);
    assert.includes(rate.denominatorNote, 'open encounter');
  });

  test('time in observation before conversion uses the observation segment', function () {
    var conv = m.observation.OSIP_001.detail;
    assert.ok(conv.length >= 1);
    conv.forEach(function (c) {
      assert.equal(c.os.serviceClass, 'OS');
      assert.equal(c.ip.serviceClass, 'IP');
      assert.close(c.osHours, c.os.durationHours, 1e-12);
    });
  });
});

describe('swing-bed metrics', function () {

  test('transition counts match the accepted links', function () {
    assert.equal(m.swingBed.IPSB_001.value, UR.transitionLinker.countPair(state.transitions, 'IP', 'SB'));
    assert.equal(m.swingBed.SBIP_001.value, UR.transitionLinker.countPair(state.transitions, 'SB', 'IP'));
    assert.equal(m.swingBed.OSSB_001.value, UR.transitionLinker.countPair(state.transitions, 'OS', 'SB'));
  });

  test('swing-bed LOS is kept separate from acute LOS', function () {
    m.swingBed.SB_LOS_001.encounters.forEach(function (e) { assert.equal(e.serviceClass, 'SB'); });
  });
});

describe('patient days and census', function () {

  test('a stay wholly inside the period contributes its exact hours', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9201', 'C1', 'CENSUS, TEST', 'IP', '08/10/2026', 600, '08/13/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.close(s.metrics.census.PD_EQ_001.value, 3, 1e-9, '72 hours = 3 equivalent days');
    assert.equal(s.metrics.census.PD_MN_001.value, 3, 'midnights of 08/11, 08/12, 08/13');
    assert.close(s.metrics.census.ADC_EQ_001.value, 3 / 31, 1e-9);
    assert.close(s.metrics.census.ADC_MN_001.value, 3 / 31, 1e-9);
  });

  test('a stay crossing the period boundary contributes only in-period time', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9202', 'C2', 'SPAN, TEST', 'IP', '07/30/2026', 0, '08/03/2026', 0, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.close(s.metrics.census.PD_EQ_001.value, 2, 1e-9, '08/01 00:00 to 08/03 00:00 is 2 days inside August');
    assert.equal(s.metrics.census.PD_MN_001.value, 2, 'midnights of 08/01 and 08/02');
  });

  test('the two methods diverge for short stays, as designed', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9203', 'C3', 'SHORT, TEST', 'IP', '08/10/2026', '2350', '08/11/2026', '0010', 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.close(s.metrics.census.PD_EQ_001.value, (20 / 60) / 24, 1e-9, '20 minutes time-weighted');
    assert.equal(s.metrics.census.PD_MN_001.value, 1, 'but one midnight was crossed');
  });

  test('open encounters are counted through the as-of datetime only', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9204', 'C4', 'OPEN, TEST', 'IP', '08/29/2026', 0, '', '', 'BCBS', '', 1]
    ];
    var withOpen = fixtures.run(UR, { matrix: matrix, asOf: util.mkDT(2026, 8, 31, 0, 0) });
    assert.close(withOpen.metrics.census.PD_EQ_001.value, 2, 1e-9, '08/29 00:00 to 08/31 00:00');

    var config = fixtures.buildConfig(UR);
    config.processing.includeOpenInOccupancy = false;
    var withoutOpen = fixtures.run(UR, { matrix: matrix, config: config, asOf: util.mkDT(2026, 8, 31, 0, 0) });
    assert.equal(withoutOpen.metrics.census.PD_EQ_001.value, 0, 'excluded when configured off');
  });

  test('service admissions and episode counts are reported separately', function () {
    var c = m.census;
    assert.equal(c.ADM_SVC_001.value, c.ADM_SVC_001.ip + c.ADM_SVC_001.os + c.ADM_SVC_001.sb);
    assert.ok(c.ADM_SVC_001.value > c.EPISODE_CNT_001.value,
      'the fixture contains internal transitions, so service accounts exceed episodes');
    assert.includes(c.ADM_SVC_001.note, 'internal status transitions');
  });

  test('unique patients counts distinct MRNs', function () {
    var mrns = {};
    UR.scope.includedAdmittedInPeriod(state.encounters, state.period).forEach(function (e) {
      if (e.mrn) { mrns[e.mrn] = true; }
    });
    assert.equal(m.census.PATIENT_CNT_001.value, Object.keys(mrns).length);
  });
});

describe('payer, disposition, and mortality', function () {

  test('deaths come from the mapped discharge-code category', function () {
    assert.equal(m.payer.DEATH_001.value, 1);
    assert.equal(m.payer.DEATH_001.accounts[0], 'B501');
    assert.equal(m.payer.DEATH_001.byPayer[UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE], 1);
  });

  test('payer mix is reported by category and by raw code', function () {
    var mix = m.payer.PAYER_MIX_001;
    assert.ok(mix.byCategory.length > 1);
    assert.ok(mix.byRawCode.length > 1);
    var rawCodes = mix.byRawCode.map(function (r) { return r.key; });
    assert.ok(rawCodes.indexOf('MCR') >= 0, 'the raw insurance code survives aggregation');
    var catKeys = mix.byCategory.map(function (r) { return r.key; });
    assert.ok(catKeys.indexOf(UR.PAYER_CATEGORY.MEDICARE_FFS) >= 0);
  });

  test('an unmapped insurance code lands in Unknown and is excluded from Medicare rules', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9301', 'P1', 'UNMAPPED, TEST', 'IP', '08/10/2026', 600, '08/11/2026', 600, 'ZZZ', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters[0].payerCategory, UR.PAYER_CATEGORY.UNKNOWN);
    assert.equal(s.metrics.inpatient.IP_2MN_001.value, 0, 'not counted as a Medicare short stay');
    var warned = s.diagnostics.all().some(function (d) { return d.ruleId === 'DQ_INS_UNKNOWN'; });
    assert.ok(warned, 'but the gap is reported');
  });

  test('admission sources are summarized when the column is mapped', function () {
    assert.ok(m.payer.ADMSRC_001.available);
    assert.ok(m.payer.ADMSRC_001.rows.length > 0);
    var labels = m.payer.ADMSRC_001.rows.map(function (r) { return r.label; });
    assert.ok(labels.indexOf('HOME') >= 0, 'origin code 01 resolves to HOME');
  });

  test('day-of-week counts are produced for admissions and discharges', function () {
    var admits = 0;
    m.payer.DOW_001.admits.forEach(function (n) { admits += n; });
    assert.equal(admits, m.census.ADM_SVC_001.value);
  });
});

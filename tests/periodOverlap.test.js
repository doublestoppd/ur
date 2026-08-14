/*
 * Period overlap semantics: a stay that only partly overlaps the reporting
 * period participates in in-scope figures (unique patients, review lists,
 * conversion denominators), transition counts anchor on the transition
 * moment, and admission counts stay event-based.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

describe('scope.overlapsPeriod', function () {

  var period = UR.scope.makePeriod(util.mkDT(2026, 8, 1, 0, 0), util.mkDT(2026, 8, 31, 0, 0),
    util.mkDT(2026, 9, 1, 0, 0));

  function enc(admit, discharge, isOpen) {
    return { admitDT: admit, dischargeDT: discharge || null, isOpen: !!isOpen };
  }

  test('a stay crossing the period start overlaps', function () {
    assert.ok(UR.scope.overlapsPeriod(
      enc(util.mkDT(2026, 7, 25, 8, 0), util.mkDT(2026, 8, 10, 9, 0)), period));
  });

  test('a stay ending exactly at the period start does not overlap', function () {
    assert.ok(!UR.scope.overlapsPeriod(
      enc(util.mkDT(2026, 7, 25, 8, 0), util.mkDT(2026, 8, 1, 0, 0)), period));
  });

  test('a stay beginning exactly at the exclusive end does not overlap', function () {
    assert.ok(!UR.scope.overlapsPeriod(
      enc(period.endExclusiveDT, null, true), period));
  });

  test('an open stay admitted before the period runs to the as-of and overlaps', function () {
    assert.ok(UR.scope.overlapsPeriod(
      enc(util.mkDT(2026, 7, 20, 8, 0), null, true), period));
  });

  test('a stay wholly before the period does not overlap', function () {
    assert.ok(!UR.scope.overlapsPeriod(
      enc(util.mkDT(2026, 6, 1, 8, 0), util.mkDT(2026, 6, 5, 8, 0)), period));
  });
});

describe('boundary-crossing stays in period figures', function () {

  /* One Medicare inpatient admitted before August whose stay reaches into it,
   * plus one ordinary August inpatient as a control. */
  var matrix = [
    fixtures.HEADERS.slice(),
    [61, 'X001', 'CROSSER, TEST', 'IP', '07/25/2026', 800, '08/10/2026', 900, 'MCR', 'H', 1],
    [63, 'X002', 'INSIDE, TEST', 'IP', '08/05/2026', 800, '08/08/2026', 900, 'MCR', 'H', 1]
  ];
  var s = fixtures.run(UR, { matrix: matrix });

  test('the boundary-crossing patient counts in unique patients', function () {
    assert.equal(s.metrics.census.PATIENT_CNT_001.value, 2,
      'both patients are in scope during August');
  });

  test('the boundary-crossing stay is in scope for work lists', function () {
    var inScope = UR.scope.inScopeInPeriod(s.encounters, UR.SERVICE.IP, s.period);
    assert.ok(inScope.some(function (e) { return e.account === 'X001'; }),
      'X001 overlaps the period and is in scope');
    assert.ok(inScope.some(function (e) { return e.account === 'X002'; }));
  });

  test('the admission event itself stays outside the period', function () {
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 1,
      'only X002 was ADMITTED inside August');
    assert.ok(s.metrics.inpatient.IP_ADM_001.accounts.indexOf('X001') < 0);
  });

  test('the partial overlap is reported as counting, not excluded', function () {
    var msgs = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_OUT_OF_PERIOD'; });
    assert.ok(msgs.some(function (d) { return d.message.indexOf('stay reaches into it') >= 0; }),
      'the partial-overlap variant of DQ_OUT_OF_PERIOD is raised');
    assert.ok(!msgs.some(function (d) { return d.message.indexOf('wholly outside') >= 0; }),
      'no record here is wholly outside the period');
  });
});

describe('wholly-outside stays', function () {

  var matrix = [
    fixtures.HEADERS.slice(),
    [41, 'Y001', 'BEFORE, TEST', 'IP', '06/10/2026', 800, '06/12/2026', 900, 'BCBS', 'H', 1],
    [43, 'Y002', 'INSIDE, TEST', 'IP', '08/05/2026', 800, '08/08/2026', 900, 'BCBS', 'H', 1]
  ];
  var s = fixtures.run(UR, { matrix: matrix });

  test('a stay with no overlap contributes to no period figure', function () {
    assert.equal(s.metrics.census.PATIENT_CNT_001.value, 1);
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 1);
    var msgs = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_OUT_OF_PERIOD'; });
    assert.ok(msgs.some(function (d) { return d.message.indexOf('wholly outside') >= 0; }));
  });
});

describe('transition-moment anchoring', function () {

  test('an OS -> IP conversion counts when the status change is inside the period', function () {
    /* Observation began in July; the conversion (IP admission) happened 08/01. */
    var matrix = [
      fixtures.HEADERS.slice(),
      [51, 'Z101', 'CONVERT, TEST', 'OS', '07/30/2026', 900, '08/01/2026', 800, 'MCR', 'B', 1],
      [51, 'Z102', 'CONVERT, TEST', 'IP', '08/01/2026', 830, '08/03/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.metrics.observation.OSIP_001.value, 1,
      'the conversion moment falls inside August even though the OS stay began in July');
    assert.equal(s.metrics.observation.OSIP_RATE_001.denominator, 1,
      'the July-admitted OS stay is in scope during August and belongs in the denominator');
    assert.equal(s.metrics.observation.OS_ADM_001.value, 0,
      'the observation ADMISSION event stays in July');
  });

  test('a conversion wholly before the period does not count', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [53, 'W101', 'EARLY, TEST', 'OS', '07/10/2026', 900, '07/11/2026', 800, 'MCR', 'B', 1],
      [53, 'W102', 'EARLY, TEST', 'IP', '07/11/2026', 830, '07/13/2026', 1000, 'MCR', 'H', 1],
      [55, 'W201', 'FILL, TEST', 'IP', '08/05/2026', 800, '08/07/2026', 900, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.metrics.observation.OSIP_001.value, 0,
      'the transition moment (07/11) is outside August');
  });

  test('an IP -> SB transition counts when the swing-bed admission is inside the period', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [57, 'V101', 'SWING, TEST', 'IP', '07/28/2026', 800, '08/02/2026', 900, 'MCR', 'Q', 1],
      [57, 'V102', 'SWING, TEST', 'SB', '08/02/2026', 930, '08/09/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.metrics.swingBed.IPSB_001.value, 1,
      'anchored on the transition moment, not the inpatient admission');
  });
});

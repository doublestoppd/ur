/*
 * The objective review queue (spec 10).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);
var queue = state.reviewQueue;

function rowsFor(ruleId) {
  return queue.rows.filter(function (r) { return r.ruleId === ruleId; });
}

describe('review queue', function () {

  test('every row names the rule that produced it', function () {
    assert.ok(queue.rows.length > 0, 'the fixture produces review work');
    queue.rows.forEach(function (r) {
      assert.ok(UR.reviewRules.byId(r.ruleId), 'unregistered review rule ' + r.ruleId);
      assert.ok(r.ruleName, 'row has a readable reason');
      assert.ok(r.detail, r.ruleId + ' row has supporting detail');
    });
  });

  test('long stays, one-day stays, and short Medicare stays are listed', function () {
    assert.ok(rowsFor('RQ_IP_GT4').some(function (r) { return r.account === 'B001'; }));
    assert.ok(rowsFor('RQ_SHORT_MCR').some(function (r) { return r.account === 'B101'; }));
    assert.equal(rowsFor('RQ_1DAY').length, state.metrics.inpatient.IP_SHORT_001.value);
  });

  test('confirmed transitions appear with both linked accounts', function () {
    var conv = rowsFor('RQ_OS_IP');
    assert.ok(conv.length >= 1);
    var a101 = conv.filter(function (r) { return r.account === 'A101'; })[0];
    assert.ok(a101);
    assert.equal(a101.relatedAccount, 'A102');
    assert.close(a101.gapMinutes, 4, 1e-9);

    var ipsb = rowsFor('RQ_IP_SB');
    assert.ok(ipsb.some(function (r) { return r.account === 'A102' && r.relatedAccount === 'A103'; }));
    var sbip = rowsFor('RQ_SB_IP');
    assert.ok(sbip.some(function (r) { return r.account === 'A103' && r.relatedAccount === 'A104'; }));
  });

  test('IMM candidates are every mapped Medicare inpatient admission', function () {
    var imm = rowsFor('RQ_IMM');
    var expected = UR.scope.admittedInPeriod(state.encounters, UR.SERVICE.IP, state.period)
      .filter(function (e) { return UR.util.contains(UR.MEDICARE_CATEGORIES, e.payerCategory); });
    assert.equal(imm.length, expected.length);
    imm.forEach(function (r) {
      assert.ok(UR.util.contains(UR.MEDICARE_CATEGORIES, r.payerCategory));
      assert.includes(r.detail, 'Manual verification required');
    });
  });

  test('MOON candidates require Medicare and the hour threshold', function () {
    var moon = rowsFor('RQ_MOON');
    assert.ok(moon.length >= 1);
    moon.forEach(function (r) {
      assert.equal(r.service, UR.SERVICE.OS);
      assert.ok(UR.util.contains(UR.MEDICARE_CATEGORIES, r.payerCategory));
      assert.ok(r.measure > state.config.thresholds.moonThresholdHours);
      assert.includes(r.detail, 'Manual verification required');
    });
    var selfPayObs = moon.filter(function (r) { return r.account === 'B601'; });
    assert.equal(selfPayObs.length, 0, 'a self-pay 72-hour observation is not a MOON candidate');
  });

  test('an observation patient still in house past the threshold is flagged', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [21, 'OPEN1', 'INHOUSE, TEST', 'OS', '08/28/2026', 800, '', '', 'MCR', '', 2]
    ];
    /* Admitted 08/28 08:00 and still in observation at 08/30 12:00 - 52 hours. */
    var s = fixtures.run(UR, { matrix: matrix, asOf: UR.util.mkDT(2026, 8, 30, 12, 0) });
    var flagged = s.reviewQueue.rows.filter(function (r) { return r.ruleId === 'RQ_OS_48' && r.account === 'OPEN1'; });
    assert.equal(flagged.length, 1, 'a 48-hour open observation reaches the reviewer');
    assert.equal(flagged[0].isOpen, true);
    assert.includes(flagged[0].detail, 'still open');
    assert.equal(s.metrics.observation.OS_48_001.value, 0, 'while the count metric still excludes open stays');
  });

  test('transition problems reach the queue', function () {
    var transitionRows = rowsFor('RQ_TRANSITION');
    var accounts = transitionRows.map(function (r) { return r.account; });
    assert.ok(accounts.indexOf('A301') >= 0, 'missing successor');
    assert.ok(accounts.indexOf('A401') >= 0, 'ambiguous candidates');
  });

  test('data defects reach the queue', function () {
    var dataRows = rowsFor('RQ_DATA');
    var accounts = dataRows.map(function (r) { return r.account; });
    assert.ok(accounts.indexOf('A701') >= 0, 'the unrecognized service code account is listed');
  });

  test('one account may carry several reasons', function () {
    var multi = queue.byAccount.filter(function (a) { return a.reasonCount > 1; });
    assert.ok(multi.length > 0, 'the grouped view collapses reasons per account');
    multi.forEach(function (a) {
      assert.ok(a.ruleIds.indexOf(',') > 0, a.account + ' lists each rule id');
    });
  });

  test('the queue is ordered by priority', function () {
    for (var i = 1; i < queue.rows.length; i++) {
      assert.ok(queue.rows[i - 1].priority <= queue.rows[i].priority, 'rows stay in priority order');
    }
  });

  test('counts are reported for every registered trigger', function () {
    UR.reviewRules.ids().forEach(function (id) {
      assert.ok(typeof queue.counts[id] === 'number', 'no count for ' + id);
    });
  });

  test('no queue row asserts a clinical conclusion', function () {
    var forbidden = ['not medically necessary', 'should be denied', 'inappropriate admission', 'non-compliant'];
    queue.rows.forEach(function (r) {
      var text = (r.detail + ' ' + r.ruleName).toLowerCase();
      forbidden.forEach(function (phrase) {
        assert.ok(text.indexOf(phrase) < 0, r.ruleId + ' asserted "' + phrase + '"');
      });
    });
  });
});

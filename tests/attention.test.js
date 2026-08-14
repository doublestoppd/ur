/*
 * The Overview digest: the short list the page leads with.
 *
 * Held to two promises: everything that genuinely needs a user's action shows
 * up with a working action, and a clean run stays quiet.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

function messagesOf(items) {
  return items.map(function (i) { return i.message; }).join(' | ');
}

describe('attention digest', function () {

  test('the fixture run surfaces its known problems, each with an action', function () {
    var state = fixtures.run(UR);
    var items = UR.attention.build(state);

    var text = messagesOf(items);
    assert.includes(text, 'unrecognized service code(s)');
    assert.includes(text, 'ZZ');
    assert.includes(text, 'unrecognized discharge code(s)');
    assert.includes(text, 'status transition(s) could not be linked cleanly');
    assert.includes(text, 'missing a successor');
    assert.includes(text, 'ambiguous');
    assert.includes(text, 'still open at export time');
    assert.includes(text, 'on the review queue');

    items.forEach(function (i) {
      assert.ok(i.action, 'every digest line carries an action: ' + i.message);
      assert.ok(i.action.view || i.action.expand, i.message + ' has a destination');
    });
    assert.ok(UR.attention.hasProblems(items), 'warnings count as problems');
  });

  test('items arrive sorted by severity', function () {
    var state = fixtures.run(UR);
    var items = UR.attention.build(state);
    var last = -1;
    items.forEach(function (i) {
      var rank = UR.SEVERITY_ORDER.indexOf(i.severity);
      assert.ok(rank >= last, 'severity never rises again after falling');
      last = rank;
    });
  });

  test('unrecognized codes point at the right Rules tab', function () {
    var state = fixtures.run(UR);
    var items = UR.attention.build(state);
    var service = items.filter(function (i) { return i.message.indexOf('service code') >= 0; })[0];
    assert.equal(service.action.view, 'rules');
    assert.equal(service.action.tab, 'serviceCodes');
    var discharge = items.filter(function (i) { return i.message.indexOf('discharge code') >= 0; })[0];
    assert.equal(discharge.action.tab, 'dischargeCodes');
  });

  test('a blocked run reduces to its blocking causes and their fixes', function () {
    var s = fixtures.run(UR, {
      matrix: [
        fixtures.HEADERS.slice(),
        [21, 'Q1', 'X', 'QQ', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
      ]
    });
    assert.ok(s.blocked);
    var items = UR.attention.build(s);
    assert.ok(items.length >= 1);
    items.forEach(function (i) { assert.equal(i.severity, UR.SEVERITY.BLOCKING); });
    var service = items.filter(function (i) { return i.action.tab === 'serviceCodes'; });
    assert.equal(service.length, 1, 'the service-table fix is the pointed-to action');
  });

  test('a refused transition names its cause in the digest', function () {
    var s = fixtures.run(UR, {
      matrix: [
        fixtures.HEADERS.slice(),
        [23, '123', 'OVERLAP, TEST', 'SB', '06/20/2026', 900, '06/27/2026', 855, 'M', 'V', '07'],
        [23, '456', 'OVERLAP, TEST', 'IP', '06/27/2026', 600, '06/30/2026', 1100, 'M', 'H', '03']
      ],
      config: UR.configSchema.defaults(),
      periodStart: UR.util.mkDT(2026, 6, 1, 0, 0),
      periodEnd: UR.util.mkDT(2026, 6, 30, 0, 0),
      asOf: UR.util.mkDT(2026, 7, 1, 0, 0)
    });
    var items = UR.attention.build(s);
    assert.includes(messagesOf(items), 'refused on contradictory times');
  });

  test('a clean run keeps the digest to informational work items only', function () {
    var s = fixtures.run(UR, {
      matrix: [
        fixtures.HEADERS.slice(),
        [25, 'CLEAN1', 'CLEAN, TEST', 'IP', '08/10/2026', 600, '08/10/2026', 2000, 'M', 'H', '04']
      ],
      config: UR.configSchema.defaults()
    });
    var items = UR.attention.build(s);
    assert.notOk(UR.attention.hasProblems(items), 'nothing above Info: ' + messagesOf(items));
    assert.includes(messagesOf(items), 'review queue', 'the work item still shows (review rows exist)');
  });
});

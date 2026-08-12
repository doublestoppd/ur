/*
 * Internal readmission indicators (spec 9.7, fixtures T08 and T09).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);
var detector = UR.readmissionDetector;

function pairFor(account) {
  var pairs = state.readmissions.pairs;
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i].newIPAccount === account) { return pairs[i]; }
  }
  return null;
}

describe('readmission indicators', function () {

  test('T08 flags a 17-day gap as a 30-day but not a 7-day readmission', function () {
    var p = pairFor('A602');
    assert.ok(p, 'the pair is detected');
    assert.close(p.daysBetween, 17, 1e-9, '08/03 11:00 to 08/20 11:00 is exactly 17 days');
    assert.equal(p.within['30'], true);
    assert.equal(p.within['7'], false);
    assert.equal(p.priorEpisodeId, state.episodesById[p.priorEpisodeId].episodeId);
  });

  test('T09 never reports an internal status transition as a readmission', function () {
    var pairs = state.readmissions.pairs;
    for (var i = 0; i < pairs.length; i++) {
      assert.notEqual(pairs[i].newIPAccount, 'A102', 'the OS -> IP conversion account must not appear');
      assert.notEqual(pairs[i].newIPAccount, 'A104', 'the SB -> IP conversion account must not appear');
    }
    assert.equal(pairFor('A102'), null);
    assert.equal(pairFor('A104'), null);
  });

  test('the readmitting payer decides the Medicare subset', function () {
    var medicare = detector.medicareWithin(state.readmissions.pairs, 30);
    for (var i = 0; i < medicare.length; i++) {
      assert.ok(UR.util.contains(UR.MEDICARE_CATEGORIES, medicare[i].payerCategory));
    }
    var p = pairFor('A602');
    assert.equal(p.isMedicare, true, 'A602 is Medicare fee-for-service');
  });

  test('a prior episode without acute inpatient care is not an index stay', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [21, 'X1', 'OBSONLY, TEST', 'OS', '08/01/2026', 800, '08/01/2026', 2000, 'MCR', 'H', 1],
      [21, 'X2', 'OBSONLY, TEST', 'IP', '08/10/2026', 800, '08/12/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.readmissions.pairs.length, 0, 'an observation-only prior stay does not qualify');
  });

  test('an open prior episode cannot be an index stay', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [23, 'Y1', 'OPEN, TEST', 'IP', '08/01/2026', 800, '', '', 'MCR', '', 1],
      [23, 'Y2', 'OPEN, TEST', 'IP', '08/10/2026', 800, '08/12/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.readmissions.pairs.length, 0, 'no final discharge means no measurable interval');
  });

  test('a gap beyond the longest window is not reported', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [25, 'Z1', 'FAR, TEST', 'IP', '07/01/2026', 800, '07/02/2026', 1000, 'MCR', 'H', 1],
      [25, 'Z2', 'FAR, TEST', 'IP', '08/15/2026', 800, '08/17/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.readmissions.pairs.length, 0, '44 days exceeds the 30-day window');
  });

  test('incomplete lookback at the start of the range is reported', function () {
    var found = false;
    state.diagnostics.all().forEach(function (d) {
      if (d.ruleId === 'DQ_LOOKBACK') {
        found = true;
        assert.includes(d.message, 'understate');
      }
    });
    assert.ok(found, 'the tool states that early readmission counts are incomplete');
    assert.ok(state.readmissions.lookback.affectedEpisodes > 0);
  });

  test('period attribution follows the readmitting episode', function () {
    var counts = UR.pipeline.readmissionsInPeriod(state, state.period);
    assert.ok(counts.long >= 1, 'the August readmission is counted in August');
    var july = UR.scope.makePeriod(UR.util.mkDT(2026, 7, 1, 0, 0), UR.util.mkDT(2026, 7, 31, 0, 0));
    assert.equal(UR.pipeline.readmissionsInPeriod(state, july).long, 0);
  });
});

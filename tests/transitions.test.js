/*
 * Status-transition reconstruction and episode building
 * (spec 8, fixtures T01-T07, T09).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var LC = UR.LINK_CONFIDENCE;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);

function encounter(account) {
  for (var i = 0; i < state.encounters.length; i++) {
    if (state.encounters[i].account === account) { return state.encounters[i]; }
  }
  return null;
}

function transitionFrom(account) {
  for (var i = 0; i < state.transitions.length; i++) {
    if (state.transitions[i].fromAccount === account) { return state.transitions[i]; }
  }
  return null;
}

function diagnosticsFor(account, ruleId) {
  var out = [];
  var all = state.diagnostics.all();
  for (var i = 0; i < all.length; i++) {
    if (all[i].account === account && (!ruleId || all[i].ruleId === ruleId)) { out.push(all[i]); }
  }
  return out;
}

describe('transitions - accepted links', function () {

  test('T01 links a 4-minute OS -> IP status change', function () {
    var t = transitionFrom('A101');
    assert.ok(t, 'a transition was attempted for A101');
    assert.equal(t.confidence, LC.CONFIRMED);
    assert.equal(t.toAccount, 'A102');
    assert.equal(t.fromService, 'OS');
    assert.equal(t.toService, 'IP');
    assert.close(t.gapMinutes, 4, 1e-9, 'gap in minutes');
    assert.equal(encounter('A101').episodeId, encounter('A102').episodeId, 'same episode');
  });

  test('T02 links IP -> SB on discharge code Q', function () {
    var t = transitionFrom('A102');
    assert.equal(t.confidence, LC.CONFIRMED);
    assert.equal(t.toAccount, 'A103');
    assert.close(t.gapMinutes, 4, 1e-9);
    assert.equal(encounter('A102').episodeId, encounter('A103').episodeId);
  });

  test('T03 links SB -> IP on the hospital-specific reading of code V', function () {
    var t = transitionFrom('A103');
    assert.equal(t.confidence, LC.CONFIRMED);
    assert.equal(t.toAccount, 'A104');
    assert.equal(t.fromService, 'SB');
    assert.equal(t.toService, 'IP');
    assert.equal(encounter('A103').episodeId, encounter('A104').episodeId);
  });

  test('T04 links OS -> SB when code Q follows an observation account', function () {
    var t = transitionFrom('A201');
    assert.equal(t.confidence, LC.CONFIRMED);
    assert.equal(t.toAccount, 'A202');
    assert.equal(t.fromService, 'OS');
    assert.equal(t.toService, 'SB');
  });

  test('code V only means SB -> IP when the source account is swing bed', function () {
    var rule = UR.configSchema.dischargeCode(state.config, 'V');
    assert.deepEqual(rule.transitionFrom, ['SB'], 'the hospital-specific restriction is explicit');
    var ipWithV = UR.normalizeEncounter.normalizeOne(
      { cells: ['9001', 'ZTEST', 'X', 'IP', '08/03/2026', 800, '08/04/2026', 900, 'MCR', 'V', 1], sourceRowNumber: 99 },
      {
        mapping: state.mapping, config: state.config, diagnostics: UR.diagnostics.create(),
        sourceFile: 'x', sourceSheet: 'y', nextRowId: function () { return 9999; }
      }
    );
    assert.equal(ipWithV.transitionTo, null, 'an IP account discharged with V expects no successor');
  });
});

describe('transitions - refusals', function () {

  test('T05 reports a missing expected successor and invents no link', function () {
    var t = transitionFrom('A301');
    assert.equal(t.confidence, LC.MISSING);
    assert.equal(t.toAccount, '');
    assert.equal(diagnosticsFor('A301', 'DQ_TRANS_MISSING').length, 1);
    assert.equal(encounter('A301').linkNext, null);
  });

  test('T06 refuses to guess between two plausible successors', function () {
    var t = transitionFrom('A401');
    assert.equal(t.confidence, LC.AMBIGUOUS);
    assert.equal(t.toAccount, '', 'no link is made');
    assert.equal(t.candidateAccounts.length, 2);
    assert.equal(diagnosticsFor('A401', 'DQ_TRANS_AMBIGUOUS').length, 1);
    assert.notEqual(encounter('A401').episodeId, encounter('A402').episodeId, 'the accounts stay in separate episodes');
    assert.notEqual(encounter('A401').episodeId, encounter('A403').episodeId);
  });

  test('T07 does not merge a same-day return on timing alone', function () {
    assert.equal(encounter('A501').linkNext, null);
    assert.notEqual(encounter('A501').episodeId, encounter('A502').episodeId,
      'two IP stays on one day are two episodes, not one');
  });

  test('a same-day service change with no transition code is reported, never linked', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['7001', 'U1', 'UNCODED, TEST', 'OS', '08/03/2026', 800, '08/03/2026', 1200, 'MCR', 'H', 1],
      ['7001', 'U2', 'UNCODED, TEST', 'IP', '08/03/2026', 1230, '08/05/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var uncoded = null;
    for (var i = 0; i < s.transitions.length; i++) {
      if (s.transitions[i].confidence === LC.UNLINKED) { uncoded = s.transitions[i]; }
    }
    assert.ok(uncoded, 'the possible uncoded transition is surfaced');
    assert.includes(uncoded.issue, 'uncoded');
    var enc = null;
    for (var j = 0; j < s.encounters.length; j++) { if (s.encounters[j].account === 'U1') { enc = s.encounters[j]; } }
    assert.equal(enc.linkNext, null, 'still not linked');
    assert.equal(s.episodes.length, 2, 'two separate episodes');
  });

  test('a successor outside the configured gap is not linked', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['7002', 'G1', 'GAP, TEST', 'OS', '08/03/2026', 800, '08/03/2026', 1200, 'MCR', 'B', 1],
      ['7002', 'G2', 'GAP, TEST', 'IP', '08/03/2026', 1600, '08/05/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.transitions[0].confidence, LC.MISSING, '240 minutes exceeds the 120-minute maximum');
    assert.equal(s.episodes.length, 2);
  });

  test('a small overlap links as probable and always warns', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['7003', 'O1', 'OVERLAP, TEST', 'OS', '08/03/2026', 800, '08/03/2026', 1200, 'MCR', 'B', 1],
      ['7003', 'O2', 'OVERLAP, TEST', 'IP', '08/03/2026', 1155, '08/05/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.transitions[0].confidence, LC.PROBABLE);
    assert.close(s.transitions[0].gapMinutes, -5, 1e-9);
    assert.equal(s.episodes.length, 1, 'still one continuous episode');
    var warned = false;
    s.diagnostics.all().forEach(function (d) { if (d.ruleId === 'DQ_TRANS_OVERLAP') { warned = true; } });
    assert.ok(warned, 'the overlap is reported');
  });

  test('an accepted but slow transition is flagged as suspicious timing', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['7004', 'S1', 'SLOW, TEST', 'OS', '08/03/2026', 800, '08/03/2026', 1200, 'MCR', 'B', 1],
      ['7004', 'S2', 'SLOW, TEST', 'IP', '08/03/2026', 1330, '08/05/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.transitions[0].confidence, LC.CONFIRMED, '90 minutes is inside the 120-minute maximum');
    var flagged = false;
    s.diagnostics.all().forEach(function (d) { if (d.ruleId === 'DQ_TRANS_GAP') { flagged = true; } });
    assert.ok(flagged, 'but it exceeds the 60-minute suspicious threshold and is flagged');
  });

  test('a successor of the wrong service is reported as a mismatch', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['7005', 'M1', 'MISMATCH, TEST', 'IP', '08/03/2026', 800, '08/03/2026', 1200, 'MCR', 'Q', 1],
      ['7005', 'M2', 'MISMATCH, TEST', 'OS', '08/03/2026', 1210, '08/04/2026', 1000, 'MCR', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var mismatch = false;
    s.diagnostics.all().forEach(function (d) { if (d.ruleId === 'DQ_TRANS_MISMATCH') { mismatch = true; } });
    assert.ok(mismatch, 'the wrong-service candidate is reported');
    assert.equal(s.transitions[0].toAccount, '', 'and not linked');
  });
});

describe('episodes', function () {

  test('the spec 8.4 example becomes one four-account episode', function () {
    var ep = state.episodesById[encounter('A101').episodeId];
    assert.equal(ep.accountCount, 4);
    assert.equal(ep.serviceSequence.join(' -> '), 'OS -> IP -> SB -> IP');
    assert.deepEqual(ep.accounts, ['A101', 'A102', 'A103', 'A104']);
    assert.equal(UR.util.fmtDateTime(ep.startDT), '08/03/2026 10:15');
    assert.equal(UR.util.fmtDateTime(ep.endDT), '08/18/2026 12:00');
    assert.equal(ep.finalDischargeCode, 'H');
    assert.ok(ep.containsIP && ep.containsOS && ep.containsSB);
  });

  test('each account keeps its own service-level length of stay', function () {
    assert.close(encounter('A102').durationHours, 92.4, 1e-9, 'IP segment only');
    assert.close(encounter('A101').durationHours, 28.2833333333, 1e-6, 'OS segment only');
    var ep = state.episodesById[encounter('A101').episodeId];
    assert.close(ep.acuteIPHours, encounter('A102').durationHours + encounter('A104').durationHours, 1e-9,
      'acute hours are the sum of the IP segments, not the whole episode');
  });

  test('episode identifiers are deterministic across runs', function () {
    var again = fixtures.run(UR);
    assert.equal(again.episodes.length, state.episodes.length);
    for (var i = 0; i < again.episodes.length; i++) {
      assert.equal(again.episodes[i].episodeId, state.episodes[i].episodeId, 'episode ' + i);
      assert.deepEqual(again.episodes[i].accounts, state.episodes[i].accounts);
    }
  });

  test('excluded records never join an episode', function () {
    assert.equal(encounter('A701').episodeId, null, 'unrecognized service code');
    assert.equal(encounter('A801').episodeId, null, 'service code configured as ignored');
  });
});

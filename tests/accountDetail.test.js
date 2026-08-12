/*
 * The account browser and the patient dossier behind it.
 *
 * These tests hold the view to its purpose: a reviewer must be able to sit in
 * front of the charting system and check every judgement the tool made, so the
 * source cell, the interpreted value, and the reasoning all have to be present
 * and correct - including for records the metrics excluded.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);
var detail = UR.accountDetail;

function fieldRow(rows, label) {
  for (var i = 0; i < rows.length; i++) { if (rows[i].field === label) { return rows[i]; } }
  return null;
}

describe('account list', function () {

  test('lists every imported account, including excluded ones', function () {
    var rows = detail.list(state);
    assert.equal(rows.length, state.encounters.length);
    var accounts = rows.map(function (r) { return r.account; });
    assert.ok(accounts.indexOf('A701') >= 0, 'the unrecognized service code account is listed');
    assert.ok(accounts.indexOf('A801') >= 0, 'the ignored service code account is listed');
    assert.ok(accounts.indexOf('B301') >= 0, 'the open encounter is listed');
  });

  test('each row states whether it counted and why not', function () {
    var rows = detail.list(state);
    function row(account) {
      for (var i = 0; i < rows.length; i++) { if (rows[i].account === account) { return rows[i]; } }
      return null;
    }
    assert.equal(row('A102').status, 'Included');
    assert.equal(row('A701').status, 'Excluded');
    assert.includes(row('A701').statusDetail, 'Unrecognized service code');
    assert.equal(row('B301').status, 'Open');
  });

  test('rows are chronological and carry their source location', function () {
    var rows = detail.list(state);
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1].admitDT ? rows[i - 1].admitDT.getTime() : 0;
      var cur = rows[i].admitDT ? rows[i].admitDT.getTime() : 0;
      assert.ok(prev <= cur, 'ordered by admission');
    }
    assert.ok(rows[0].sourceFile, 'the source file is recorded');
    assert.ok(rows[0].sourceRowNumber > 1, 'and the spreadsheet row');
  });

  test('search matches account, patient ID, name, and episode', function () {
    var rows = detail.list(state);
    assert.equal(detail.search(rows, 'A101', {}).length, 1);
    var pid = state.encounters.filter(function (e) { return e.account === 'A101'; })[0].mrn;
    assert.equal(detail.search(rows, pid, {}).length, 4, 'the derived Patient ID returns all four of that patient\'s accounts');
    assert.ok(detail.search(rows, 'alpha', {}).length >= 1, 'name search is case-insensitive');
    var episodeId = state.encounters.filter(function (e) { return e.account === 'A101'; })[0].episodeId;
    assert.equal(detail.search(rows, episodeId, {}).length, 4);
  });

  test('filters narrow by service, status, and review state', function () {
    var rows = detail.list(state);
    detail.search(rows, '', { service: 'OS' }).forEach(function (r) { assert.equal(r.serviceClass, 'OS'); });
    detail.search(rows, '', { status: 'excluded' }).forEach(function (r) { assert.equal(r.status, 'Excluded'); });
    detail.search(rows, '', { status: 'open' }).forEach(function (r) { assert.ok(r.isOpen); });
    detail.search(rows, '', { status: 'review' }).forEach(function (r) { assert.ok(r.reviewRuleIds.length > 0); });
  });
});

describe('patient dossier', function () {

  var dossier = detail.forAccount(state, 'A102');

  test('is keyed by patient, not by the account clicked', function () {
    assert.ok(/^P\d+$/.test(dossier.mrn), 'a derived Patient ID: ' + dossier.mrn);
    assert.equal(dossier.mrn, state.encounters.filter(function (e) { return e.account === 'A101'; })[0].mrn);
    assert.equal(dossier.totals.visits, 4, 'all four accounts of the OS -> IP -> SB -> IP course');
    assert.deepEqual(dossier.visits.map(function (v) { return v.encounter.account; }),
      ['A101', 'A102', 'A103', 'A104']);
  });

  test('shows the whole episode the visits belong to', function () {
    assert.equal(dossier.episodes.length, 1);
    assert.equal(dossier.episodes[0].serviceSequence.join(' -> '), 'OS -> IP -> SB -> IP');
  });

  test('shows the source cell beside the interpreted value for every field', function () {
    var visit = dossier.visits[0];             /* account A101, the OS record */
    assert.equal(visit.fields.length, UR.headerMapper.FIELDS.length, 'every canonical field appears');

    var service = fieldRow(visit.fields, 'Service code');
    assert.equal(service.column, 'visit_servicecd_key', 'the source column is named');
    assert.equal(service.rawValue, 'OS', 'the cell is shown exactly as imported');
    assert.includes(service.interpreted, 'Included as OS');

    var admitTime = fieldRow(visit.fields, 'Admission time');
    assert.equal(admitTime.rawValue, '1015', 'the military time is shown as it arrived');
    assert.includes(admitTime.interpreted, '08/03/2026 10:15', 'and how it was read');

    var code = fieldRow(visit.fields, 'Discharge code');
    assert.equal(code.rawValue, 'B');
    assert.includes(code.interpreted, 'expects a following IP account');
  });

  test('explains an unmapped payer rather than showing a bare category', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [21, 'UNMAP', 'TEST, UNMAPPED', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'ZZZ', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var d = detail.forAccount(s, 'UNMAP');
    var insurance = fieldRow(d.visits[0].fields, 'Insurance code');
    assert.equal(insurance.rawValue, 'ZZZ');
    assert.equal(insurance.interpreted, 'Unknown');
    assert.ok(d.visits[0].diagnostics.some(function (x) { return x.ruleId === 'DQ_INS_UNKNOWN'; }),
      'and the diagnostic sits with the visit');
  });

  test('shows an assumed midnight rather than pretending the time was known', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [23, 'NOTIME', 'TEST, NOTIME', 'IP', '08/10/2026', '', '08/12/2026', '', 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var d = detail.forAccount(s, 'NOTIME');
    var admit = fieldRow(d.visits[0].fields, 'Admission time');
    assert.equal(admit.rawValue, '(blank)');
    assert.includes(admit.interpreted, 'midnight assumed');
  });

  test('derived values explain the arithmetic', function () {
    var derived = dossier.visits[1].derived;    /* account A102, the IP record */
    function value(label) {
      for (var i = 0; i < derived.length; i++) { if (derived[i].label === label) { return derived[i].value; } }
      return null;
    }
    assert.includes(value('Elapsed duration'), '92.4 hours');
    assert.equal(value('Midnights crossed'), '4');
    assert.includes(value('Counts toward metrics'), 'Yes');
    assert.includes(value('Source'), 'row ');
    assert.includes(value('Service sequence of that episode'), 'OS -> IP -> SB -> IP');
  });

  test('an excluded account explains its exclusion', function () {
    var d = detail.forAccount(state, 'A701');
    var derived = d.visits[0].derived;
    var counts = derived.filter(function (x) { return x.label === 'Counts toward metrics'; })[0];
    assert.includes(counts.value, 'No');
    assert.includes(counts.value, 'Unrecognized service code');
    var service = fieldRow(d.visits[0].fields, 'Service code');
    assert.includes(service.interpreted, 'Unrecognized');
  });

  test('accepted transitions are shown with their gap and confidence', function () {
    var accepted = dossier.transitions.filter(function (t) {
      return t.confidence === UR.LINK_CONFIDENCE.CONFIRMED;
    });
    assert.equal(accepted.length, 3, 'OS->IP, IP->SB, SB->IP');
    assert.close(accepted[0].gapMinutes, 4, 1e-9);
  });

  test('refused transitions are shown with the reason, not hidden', function () {
    var missing = detail.forAccount(state, 'A301');
    assert.equal(missing.transitions.length, 1);
    assert.equal(missing.transitions[0].confidence, UR.LINK_CONFIDENCE.MISSING);
    assert.includes(missing.transitions[0].issue, 'No account with the expected service');

    var ambiguous = detail.forAccount(state, 'A401');
    var amb = ambiguous.transitions.filter(function (t) { return t.confidence === UR.LINK_CONFIDENCE.AMBIGUOUS; });
    assert.equal(amb.length, 1);
    assert.equal(amb[0].candidateAccounts.length, 2, 'both candidates are named so the reviewer can check them');
  });

  test('readmission pairs for the patient are included', function () {
    var d = detail.forAccount(state, 'A602');
    assert.equal(d.readmissions.length, 1);
    assert.equal(d.readmissions[0].newIPAccount, 'A602');
    assert.close(d.readmissions[0].daysBetween, 17, 1e-9);
  });

  test('review-queue reasons are attached to the visit that caused them', function () {
    var d = detail.forAccount(state, 'B001');   /* the 121-hour stay */
    var ruleIds = d.visits[0].reviewRows.map(function (r) { return r.ruleId; });
    assert.ok(ruleIds.indexOf('RQ_IP_GT4') >= 0);
  });

  test('a record with no MRN stands alone and says so', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['', 'NOMRN', 'TEST, NOMRN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      ['', 'NOMRN2', 'TEST, OTHER', 'IP', '08/14/2026', 600, '08/16/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var d = detail.forAccount(s, 'NOMRN');
    assert.equal(d.hasMrn, false);
    assert.equal(d.totals.visits, 1, 'two MRN-less records are not merged into one patient');
  });

  test('an unknown account returns nothing rather than throwing', function () {
    assert.equal(detail.forAccount(state, 'NOT-AN-ACCOUNT'), null);
  });

  test('every visit of every account can be assembled without error', function () {
    var rows = detail.list(state);
    rows.forEach(function (row) {
      var d = detail.forAccount(state, row.account);
      assert.ok(d, 'dossier for ' + row.account);
      assert.ok(d.visits.length >= 1);
      d.visits.forEach(function (v) {
        assert.equal(v.fields.length, UR.headerMapper.FIELDS.length);
        assert.ok(v.derived.length > 5);
      });
    });
  });
});

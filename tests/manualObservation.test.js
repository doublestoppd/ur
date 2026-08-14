/*
 * Operator-entered observation segments: a synthetic <account>-MANUAL OS
 * account links to its IP account as a normal conversion, the IP admission
 * moves forward to the observation discharge, and the entry is noted
 * everywhere it matters.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

function matrix() {
  return [
    fixtures.HEADERS.slice(),
    [61, 'IP900', 'MANUAL, TEST', 'IP', '08/05/2026', 800, '08/09/2026', 1000, 'MCR', 'H', 1]
  ];
}

function run(entries) {
  return fixtures.run(UR, { matrix: matrix(), manualObservations: entries });
}

describe('manual observation segments', function () {

  var s = run([{
    account: 'IP900',
    osAdmitDT: util.mkDT(2026, 8, 5, 8, 0),
    osDischargeDT: util.mkDT(2026, 8, 6, 14, 30)
  }]);

  test('a -MANUAL observation account is created with the entered datetimes', function () {
    var os = s.encounters.find(function (e) { return e.account === 'IP900-MANUAL'; });
    assert.ok(os, 'the synthetic account exists');
    assert.equal(os.serviceClass, 'OS');
    assert.ok(os.manualEntry);
    assert.equal(os.admitDT.toISOString(), '2026-08-05T08:00:00.000Z');
    assert.equal(os.dischargeDT.toISOString(), '2026-08-06T14:30:00.000Z');
    assert.close(os.durationHours, 30.5, 1e-9);
    assert.equal(os.dischargeCodeRaw, 'B', 'carries the OP -> IP transition code');
    assert.equal(os.mrn, s.encounters.find(function (e) { return e.account === 'IP900'; }).mrn,
      'same derived patient');
  });

  test('the inpatient admission moves forward to the observation discharge', function () {
    var ip = s.encounters.find(function (e) { return e.account === 'IP900'; });
    assert.equal(ip.admitDT.toISOString(), '2026-08-06T14:30:00.000Z');
    assert.equal(ip.manualObsOriginalAdmit.toISOString(), '2026-08-05T08:00:00.000Z');
    assert.ok(ip.manualObsAdjusted);
    assert.close(ip.durationHours, util.hoursBetween(ip.admitDT, ip.dischargeDT), 1e-9,
      'duration recomputed from the moved admission');
  });

  test('the segment links as a normal OS -> IP conversion in one episode', function () {
    assert.equal(s.transitionCounts.osip, 1, 'counted as a conversion');
    var link = s.transitions.find(function (t) { return t.fromAccount === 'IP900-MANUAL'; });
    assert.equal(link.confidence, UR.LINK_CONFIDENCE.CONFIRMED, 'zero gap links Confirmed');
    assert.equal(s.metrics.observation.OSIP_001.value, 1);
    var ep = s.episodes.find(function (e) { return e.accounts.indexOf('IP900') >= 0; });
    assert.deepEqual(ep.serviceSequence, ['OS', 'IP'], 'one continuous episode');
    assert.equal(ep.accounts.length, 2);
  });

  test('the entry is noted on the account, the review queue, and Run Metadata', function () {
    var notes = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_MANUAL_OS'; });
    assert.equal(notes.length, 2, 'a note on the IP account and one on the manual account');
    assert.ok(notes.some(function (d) { return d.message.indexOf('moved forward') >= 0; }));
    assert.ok(s.reviewQueue.rows.some(function (r) {
      return r.ruleId === 'RQ_DATA' && r.detail.indexOf('entered manually') >= 0;
    }), 'the note reaches the review queue');
    assert.equal(s.manualObservationsApplied.length, 1);
    var built = UR.workbookBuilder.build(s, 'test');
    var text = app.XLSX.utils.sheet_to_csv(built.workbook.Sheets['Run Metadata']);
    assert.ok(text.indexOf('IP900-MANUAL') >= 0, 'listed in Run Metadata');
  });

  test('metrics see the manual segment like real data', function () {
    assert.equal(s.metrics.observation.OS_ADM_001.value, 1, 'an observation admission in the period');
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 1);
    assert.equal(s.metrics.census.PATIENT_CNT_001.value, 1, 'still one patient');
    assert.equal(s.metrics.census.EPISODE_CNT_001.value, 1, 'still one episode');
  });

  test('invalid entries are refused with a warning, not applied', function () {
    var bad = run([
      { account: 'NOPE', osAdmitDT: util.mkDT(2026, 8, 5, 8, 0), osDischargeDT: util.mkDT(2026, 8, 6, 8, 0) },
      { account: 'IP900', osAdmitDT: util.mkDT(2026, 8, 6, 8, 0), osDischargeDT: util.mkDT(2026, 8, 5, 8, 0) },
      { account: 'IP900', osAdmitDT: util.mkDT(2026, 8, 5, 8, 0), osDischargeDT: util.mkDT(2026, 8, 10, 8, 0) }
    ]);
    assert.equal(bad.encounters.filter(function (e) { return e.manualEntry; }).length, 0, 'nothing applied');
    var refused = bad.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_MANUAL_OS_REFUSED'; });
    assert.equal(refused.length, 3);
    assert.ok(refused.some(function (d) { return d.message.indexOf('no imported account') >= 0; }));
    assert.ok(refused.some(function (d) { return d.message.indexOf('must come after') >= 0; }));
    assert.ok(refused.some(function (d) { return d.message.indexOf('must precede the inpatient discharge') >= 0; }));
    var ip = bad.encounters.find(function (e) { return e.account === 'IP900'; });
    assert.equal(ip.admitDT.toISOString(), '2026-08-05T08:00:00.000Z', 'admission untouched');
  });

  test('without the entry the run is unchanged - removal is just reprocessing without it', function () {
    var plain = run(undefined);
    assert.equal(plain.encounters.length, 1);
    assert.equal(plain.transitionCounts.osip, 0);
    assert.equal(plain.encounters[0].admitDT.toISOString(), '2026-08-05T08:00:00.000Z');
  });
});

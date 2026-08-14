/*
 * Regression tests for defects found during review.
 *
 * Each test names the failure it prevents, so a later change that reintroduces
 * one fails with an explanation rather than a bare assertion.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var XLSX = app.XLSX;
var fixtures = require('./fixtures/synthetic');

describe('configurable thresholds cannot break the run', function () {

  /*
   * The rule registry defines exactly three observation cohorts (OS_24/36/48)
   * and two readmission windows (READMIT_7/30). The UI let a user type a
   * different number of values, and the results page, the workbook, and the
   * charts then read thresholds[2] on an array of length 2.
   */
  test('a wrong number of observation thresholds is refused, not half-applied', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    payload.thresholds.obsThresholdHours = [24, 36];
    var result = UR.configSchema.validate(payload);
    assert.notOk(result.ok, 'two thresholds cannot drive three cohort rules');
    assert.includes(result.errors.join(' '), 'exactly three');
  });

  test('observation thresholds must ascend', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    payload.thresholds.obsThresholdHours = [48, 24, 36];
    var result = UR.configSchema.validate(payload);
    assert.notOk(result.ok);
    assert.includes(result.errors.join(' '), 'ascending');
  });

  test('a wrong number of readmission windows is refused', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    payload.thresholds.readmissionWindowDays = [30];
    var result = UR.configSchema.validate(payload);
    assert.notOk(result.ok);
    assert.includes(result.errors.join(' '), 'exactly two');
  });

  test('the period-inference share must be a usable fraction', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    payload.processing.periodInferenceShare = 5;
    assert.notOk(UR.configSchema.validate(payload).ok, 'a share above 1 would exclude every month');
    payload.processing.periodInferenceShare = 0.25;
    assert.ok(UR.configSchema.validate(payload).ok);
  });

  /*
   * Defence in depth: even if a malformed configuration reaches the engine, the
   * three cohort keys must exist so the results page and the workbook cannot
   * throw on a missing property.
   */
  test('the observation cohorts always exist, whatever the configuration says', function () {
    var config = fixtures.buildConfig(UR);
    config.thresholds.obsThresholdHours = [24];      /* bypassing validation */
    var s = fixtures.run(UR, { config: config });
    ['OS_24_001', 'OS_36_001', 'OS_48_001'].forEach(function (id) {
      assert.ok(s.metrics.observation[id], id + ' is present');
      assert.ok(typeof s.metrics.observation[id].value === 'number', id + ' has a count');
    });
    /* And the things that read them still build. */
    assert.ok(UR.workbookBuilder.build(s, '').workbook.SheetNames.length === 17);
    assert.ok(UR.chartData.all(s).length >= 12);
  });

  test('extra observation thresholds are kept out of the fixed cohort keys', function () {
    var config = fixtures.buildConfig(UR);
    config.thresholds.obsThresholdHours = [24, 36, 48, 72];
    var s = fixtures.run(UR, { config: config });
    assert.equal(s.metrics.observation.OS_48_001.thresholdHours, 48,
      'the third cohort stays bound to the third threshold');
    var bands = UR.chartData.all(s).filter(function (c) { return c.id === 'observation-bands'; })[0];
    var total = 0;
    bands.series[0].values.forEach(function (v) { total += v; });
    assert.equal(total, s.metrics.observation.OS_LOS_001.n, 'every stay still lands in one band');
  });
});

describe('duplicate account detection', function () {

  /*
   * Conflict detection compared a signature that omitted the patient name and
   * the admission source, so two rows sharing an account number but differing
   * only in those fields were neither de-duplicated (the rows are not
   * identical) nor flagged as conflicting - and both were counted.
   */
  test('same account, differing only by name, is a conflict rather than a double count', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [21, 'DUP1', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      [21, 'DUP1', 'SMITH, JON', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 0, 'neither copy is counted');
    assert.equal(s.accountConflicts, 1, 'the conflict is reported');
  });

  test('same account, differing only by admission source, is also a conflict', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [23, 'DUP2', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      [23, 'DUP2', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 3]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.accountConflicts, 1);
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 0);
  });

  test('identical copies are still de-duplicated rather than called a conflict', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [25, 'DUP3', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      [25, 'DUP3', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.accountConflicts, 0);
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 1, 'counted exactly once');
  });

  test('with de-duplication off, identical copies are warned about, not called conflicts', function () {
    var config = fixtures.buildConfig(UR);
    config.processing.deduplicateIdenticalRows = false;
    var matrix = [
      fixtures.HEADERS.slice(),
      [27, 'DUP4', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      [27, 'DUP4', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    assert.equal(s.accountConflicts, 0, 'identical copies are not a content conflict');
    var warned = s.diagnostics.all().some(function (d) { return d.ruleId === 'DQ_ROW_DUP'; });
    assert.ok(warned, 'but the double count is reported');
  });
});

describe('multi-file mapping', function () {

  /*
   * Only the first file's mapping was validated. A second file missing the
   * service column produced rows that silently fell out of every metric.
   */
  test('a file that cannot supply a required field is named', function () {
    var good = fixtures.buildSource(UR, { fileName: 'august.xlsx' });
    var thin = fixtures.buildSource(UR, {
      fileName: 'september.xlsx',
      matrix: [
        ['visit_mr_num', 'ipv1_num', 'ipv1_ad_date'],
        [29, 'X1', '09/02/2026']
      ]
    });
    var s = UR.pipeline.process([good, thin], fixtures.buildConfig(UR), {});
    var notice = s.diagnostics.all().filter(function (d) {
      return d.ruleId === 'DQ_MAP_REQUIRED' && String(d.sourceFile) === 'september.xlsx';
    });
    assert.ok(notice.length >= 1, 'the file missing a required column is called out by name');
    assert.includes(notice[0].message, 'Service code');
  });
});

describe('rendering robustness', function () {

  test('a chart with a single category still draws a usable axis', function () {
    var s = fixtures.run(UR);
    var specs = UR.chartData.all(s);
    var monthly = specs.filter(function (c) { return c.id === 'monthly-admissions'; })[0];
    assert.equal(monthly.categories.length, 1, 'the fixture is a single month');
    var scale = UR.chartData.niceTicks(monthly.series[0].values[0], 0, 5);
    assert.ok(scale.max > 0);
  });

  test('an entirely empty period produces charts that explain themselves', function () {
    var s = fixtures.run(UR, {
      periodStart: UR.util.mkDT(2027, 1, 1, 0, 0),
      periodEnd: UR.util.mkDT(2027, 1, 31, 0, 0)
    });
    var specs = UR.chartData.all(s);
    specs.forEach(function (spec) {
      spec.series.forEach(function (series) {
        assert.equal(series.values.length, spec.categories.length, spec.id + ' stays well formed');
      });
    });
    assert.ok(UR.workbookBuilder.build(s, '').workbook, 'and the workbook still builds');
  });
});

describe('workbook robustness', function () {

  test('a run with no review rows and no diagnostics still exports every sheet', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [31, 'CLEAN1', 'CLEAN, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var bytes = UR.workbookBuilder.toBytes(s, '');
    var wb = XLSX.read(bytes, { type: 'array' });
    assert.equal(wb.SheetNames.length, 17);
    var queue = XLSX.utils.sheet_to_csv(wb.Sheets['Review Queue']);
    assert.includes(queue, 'No account met a review trigger');
  });

  test('patient names excluded still leaves every sheet readable', function () {
    var config = fixtures.buildConfig(UR);
    config.processing.excludePatientNames = true;
    var s = fixtures.run(UR, { config: config });
    var wb = UR.workbookBuilder.build(s, '').workbook;
    wb.SheetNames.forEach(function (name) {
      var csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      assert.ok(csv.length > 0, name + ' has content');
      assert.ok(csv.indexOf('undefined') < 0, name + ' has no undefined cells');
    });
  });
});

describe('Rules-screen counts agree with the engine', function () {

  /*
   * The Rules screen used to key value counts by UPPER-CASED code while the
   * engine matches case-sensitively with numeric fallback. Two failure modes:
   * case pairs (DCg/DCG) pooled their counts onto both rows, and a numeric
   * origin column ("1" against table code "01") was offered as "unmapped" -
   * and accepting that offer inserted a bare '1' row that would then
   * exact-match future lookups, silently shadowing the real '01' mapping.
   */
  test('case pairs keep separate counts', function () {
    var rows = [
      { code: 'DCg', label: 'Humana' },
      { code: 'DCG', label: 'Lake Village' }
    ];
    var att = UR.util.attributeCounts(rows, { DCg: 5, DCG: 2 });
    assert.equal(att.byCode.DCg, 5);
    assert.equal(att.byCode.DCG, 2);
    assert.equal(att.unmatched.length, 0);
  });

  test('a numeric origin column is attributed to the padded table code, not offered as unmapped', function () {
    var defaults = UR.configSchema.defaults();
    var att = UR.util.attributeCounts(defaults.admissionSources, { '1': 10, '04': 3, '6': 2, '06': 1 });
    assert.equal(att.byCode['01'], 10, '"1" resolves to the shipped "01" row');
    assert.equal(att.byCode['04'], 3);
    assert.equal(att.byCode['6'], 3, 'both "6" and "06" land on the unpadded OBSERVATION row');
    assert.equal(att.unmatched.length, 0, 'nothing is offered for adding');
  });

  test('a value matching two rows via fallback is unmatched and marked ambiguous', function () {
    var rows = [
      { code: 'DCg', label: 'Humana' },
      { code: 'DCG', label: 'Lake Village' }
    ];
    var att = UR.util.attributeCounts(rows, { dcg: 4 });
    assert.equal(att.unmatched.length, 1);
    assert.equal(att.unmatched[0].value, 'dcg');
    assert.equal(att.unmatched[0].ambiguous, true, 'adding a new row is the wrong repair here');
    assert.equal(att.byCode.DCg, undefined, 'no count is guessed onto either row');
  });

  test('genuinely unknown values are still surfaced for adding', function () {
    var att = UR.util.attributeCounts(UR.configSchema.defaults().insuranceCodes, { NOPE: 7 });
    assert.equal(att.unmatched.length, 1);
    assert.equal(att.unmatched[0].value, 'NOPE');
    assert.equal(att.unmatched[0].ambiguous, false);
  });
});

describe('time edge cases', function () {

  test('an Excel time fraction near 1.0 clamps to 23:59 instead of wrapping to midnight', function () {
    /* 0.9999999 rounds to 1440 minutes; the old modulo turned that into 00:00
     * the SAME day, moving a 23:59:59.6 discharge back a full day. */
    var r = UR.parsers.parseTime(0.9999999);
    assert.ok(r.ok);
    assert.equal(r.value, 23 * 60 + 59);
    assert.equal(UR.parsers.parseTime(0.999).value, 1439, '23:58:33.6 also lands on 23:59');
    assert.equal(UR.parsers.parseTime(0.5).value, 720, 'ordinary fractions unchanged');
  });

  test('an unparseable time cell falls back to the time embedded in the date cell', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [33, 'EMB1', 'EMBED, TEST', 'IP', '08/03/2026 14:32', 'garbage', '08/05/2026', 1000, 'BCBS', 'H', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    var e = s.encounters[0];
    assert.equal(UR.util.fmtDateTime(e.admitDT), '08/03/2026 14:32', 'the embedded time is used');
    assert.equal(e.admitTimeAssumed, false, 'midnight was NOT assumed');
    var msgs = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_DATE_UNPARSEABLE'; });
    assert.equal(msgs.length, 1, 'the bad cell is still reported');
    assert.includes(msgs[0].message, 'embedded in the admission date cell');
    var timeMissing = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_TIME_MISSING'; });
    assert.equal(timeMissing.length, 0, 'and not double-reported as a missing time');
  });

  test('midnight is still assumed when there is no embedded time to fall back on', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [35, 'EMB2', 'EMBED, TEST', 'IP', '08/03/2026', 'garbage', '08/05/2026', 1000, 'BCBS', 'H', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(UR.util.fmtDateTime(s.encounters[0].admitDT), '08/03/2026 00:00');
    var msgs = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_DATE_UNPARSEABLE'; });
    assert.includes(msgs[0].message, 'Midnight assumed');
  });
});

describe('stale configuration imports', function () {

  test('an import that shrinks a shipped hospital table is warned about, not silent', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(UR.configSchema.defaults(), ''));
    payload.insuranceCodes = payload.insuranceCodes.slice(0, 5);
    var result = UR.configSchema.validate(payload);
    assert.ok(result.ok, 'the import still wins - that is what import is for');
    assert.equal(result.config.insuranceCodes.length, 5);
    var text = result.warnings.join(' ');
    assert.includes(text, 'insuranceCodes table has 5 row(s)');
    assert.includes(text, '736');
    assert.includes(text, 'Reset to defaults');
  });

  test('a full-size import raises no shrinkage warning', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(UR.configSchema.defaults(), ''));
    var result = UR.configSchema.validate(payload);
    assert.ok(result.ok);
    assert.notOk(/this build ships/.test(result.warnings.join(' ')), 'no false alarm on a current export');
  });
});

describe('code inventory agrees with the engine on disabled rows', function () {

  test('a retired insurance code is described as the engine treats it', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [37, 'RET2', 'RETIRED, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'MEC', 'H', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: UR.configSchema.defaults() });
    assert.equal(s.encounters[0].payerCategory, UR.PAYER_CATEGORY.UNKNOWN, 'the engine assigns Unknown');
    var ins = s.codeInventory.filter(function (x) { return x.type === 'Insurance code'; })[0];
    var row = ins.rows.filter(function (r) { return r.value === 'MEC'; })[0];
    assert.includes(row.behavior, 'Unknown', 'and the inventory says so');
    assert.ok(row.behavior.indexOf('Payer category: Other') < 0,
      'it does not claim the stored category was applied');
  });

  test('a disabled discharge code is described as unrecognized, not as its stored transition', function () {
    var config = UR.configSchema.defaults();
    config.dischargeCodes.forEach(function (r) { if (r.code === 'Q') { r.enabled = false; } });
    var matrix = [
      fixtures.HEADERS.slice(),
      [39, 'DIS1', 'DISABLED, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'M', 'Q', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    assert.equal(s.encounters[0].transitionTo, null, 'the engine assumes no transition');
    var dis = s.codeInventory.filter(function (x) { return x.type === 'Discharge code'; })[0];
    var row = dis.rows.filter(function (r) { return r.value === 'Q'; })[0];
    assert.includes(row.behavior, 'Disabled');
    assert.ok(row.behavior.indexOf('Internal transition') < 0);
  });
});

describe('registration-time overlap on coded transitions', function () {

  /*
   * Observed in live data: a genuine SB -> IP transition where registration
   * entered the IP admission (08:10) BEFORE the SB discharge (08:55). With the
   * original 15-minute tolerance the IP account was not even a candidate, so
   * the run produced a "missing successor" plus an unrelated "unexplained
   * overlap" - two warnings that never named each other.
   */
  function overlapMatrix(ipAdmitTime) {
    return [
      fixtures.HEADERS.slice(),
      /* SB discharged 08:55 with code V (SB -> IP); IP admitted earlier. */
      [41, '123', 'OVERLAP, TEST', 'SB', '06/20/2026', 900, '06/27/2026', 855, 'M', 'V', '07'],
      [41, '456', 'OVERLAP, TEST', 'IP', '06/27/2026', ipAdmitTime, '06/30/2026', 1100, 'M', 'H', '03']
    ];
  }

  function junePeriod() {
    return {
      periodStart: UR.util.mkDT(2026, 6, 1, 0, 0),
      periodEnd: UR.util.mkDT(2026, 6, 30, 0, 0),
      asOf: UR.util.mkDT(2026, 7, 1, 0, 0)
    };
  }

  test('the observed 45-minute overlap now links as Probable in one episode', function () {
    var opts = junePeriod();
    opts.matrix = overlapMatrix(810);
    opts.config = UR.configSchema.defaults();
    var s = fixtures.run(UR, opts);

    var link = s.transitions[0];
    assert.equal(link.confidence, UR.LINK_CONFIDENCE.PROBABLE, 'linked, flagged for verification');
    assert.close(link.gapMinutes, -45, 1e-9);
    assert.equal(s.episodes.length, 1, 'one continuous episode');
    assert.equal(s.episodes[0].serviceSequence.join(' -> '), 'SB -> IP');

    var overlapWarn = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_TRANS_OVERLAP'; });
    assert.equal(overlapWarn.length, 1, 'the contradictory times are still reported');
    var unexplained = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_OVERLAP_UNEXPLAINED'; });
    assert.equal(unexplained.length, 0, 'no vague double-count warning');
    var missing = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_TRANS_MISSING'; });
    assert.equal(missing.length, 0, 'no false missing-successor');
  });

  test('an overlap beyond the tolerance is refused with both accounts named', function () {
    var opts = junePeriod();
    opts.matrix = overlapMatrix(600);            /* 08:55 - 06:00 = 175-minute overlap */
    opts.config = UR.configSchema.defaults();
    var s = fixtures.run(UR, opts);

    var link = s.transitions[0];
    assert.equal(link.confidence, UR.LINK_CONFIDENCE.REFUSED);
    assert.equal(link.fromAccount, '123');
    assert.equal(link.toAccount, '456', 'the candidate is named on the transition record');
    assert.equal(s.episodes.length, 2, 'no link is invented');

    var refused = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_TRANS_OVERLAP_EXCEEDED'; });
    assert.equal(refused.length, 1);
    assert.includes(refused[0].message, '456');
    assert.includes(refused[0].message, 'BEFORE the discharge of 123');
    assert.includes(refused[0].message, 'raise the overlap tolerance');

    var unexplained = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_OVERLAP_UNEXPLAINED'; });
    assert.equal(unexplained.length, 0, 'not double-reported by the generic overlap scan');
    var missing = s.diagnostics.all().filter(function (d) { return d.ruleId === 'DQ_TRANS_MISSING'; });
    assert.equal(missing.length, 0, 'and not miscalled a missing successor');
  });

  test('the refused transition reaches the review queue and the patient dossier', function () {
    var opts = junePeriod();
    opts.matrix = overlapMatrix(600);
    opts.config = UR.configSchema.defaults();
    var s = fixtures.run(UR, opts);

    var queueRows = s.reviewQueue.rows.filter(function (r) { return r.ruleId === 'RQ_TRANSITION'; });
    assert.equal(queueRows.length, 1);
    assert.includes(queueRows[0].detail, 'Refused (timing)');

    var dossier = UR.accountDetail.forAccount(s, '123');
    assert.equal(dossier.transitions.length, 1);
    assert.equal(dossier.transitions[0].confidence, UR.LINK_CONFIDENCE.REFUSED);
    assert.includes(dossier.transitions[0].issue, 'registration times contradict');
  });

  test('a genuine forward gap still beats an overlapping decoy', function () {
    var opts = junePeriod();
    opts.config = UR.configSchema.defaults();
    opts.matrix = [
      fixtures.HEADERS.slice(),
      [41, '123', 'OVERLAP, TEST', 'SB', '06/20/2026', 900, '06/27/2026', 855, 'M', 'V', '07'],
      /* one IP overlapping far beyond tolerance, one admitted cleanly after */
      [41, '455', 'OVERLAP, TEST', 'IP', '06/27/2026', 600, '06/27/2026', 700, 'M', 'H', '03'],
      [41, '456', 'OVERLAP, TEST', 'IP', '06/27/2026', 900, '06/30/2026', 1100, 'M', 'H', '03']
    ];
    var s = fixtures.run(UR, opts);
    var link = s.transitions.filter(function (t) { return t.fromAccount === '123'; })[0];
    assert.equal(link.confidence, UR.LINK_CONFIDENCE.CONFIRMED);
    assert.equal(link.toAccount, '456', 'the clean 5-minute successor wins');
  });
});

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
      ['9901', 'DUP1', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      ['9901', 'DUP1', 'SMITH, JON', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 0, 'neither copy is counted');
    assert.equal(s.accountConflicts, 1, 'the conflict is reported');
  });

  test('same account, differing only by admission source, is also a conflict', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9902', 'DUP2', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      ['9902', 'DUP2', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 3]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.accountConflicts, 1);
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 0);
  });

  test('identical copies are still de-duplicated rather than called a conflict', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9903', 'DUP3', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      ['9903', 'DUP3', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
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
      ['9904', 'DUP4', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1],
      ['9904', 'DUP4', 'SMITH, JOHN', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
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
        ['6001', 'X1', '09/02/2026']
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
      ['9950', 'CLEAN1', 'CLEAN, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
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

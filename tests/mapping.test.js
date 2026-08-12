/*
 * Header mapping and import behavior (spec 6, acceptance criteria 1-3).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

describe('header mapping', function () {

  test('auto-maps the documented CPSI field names', function () {
    var auto = UR.headerMapper.autoMap(fixtures.HEADERS);
    var expected = {
      mrn: 'visit_mr_num',
      account: 'ipv1_num',
      name: 'visit_name',
      service: 'visit_servicecd_key',
      admitDate: 'ipv1_ad_date',
      admitTime: 'ipv1_ad_time',
      dischargeDate: 'ipv1_dis_date',
      dischargeTime: 'ipv1_dis_time',
      insurance: 'visit_ins',
      dischargeCode: 'ipv1_discd',
      admissionSource: 'origin_code'
    };
    Object.keys(expected).forEach(function (key) {
      assert.ok(auto.mapping[key], key + ' should be mapped');
      assert.equal(auto.mapping[key].header, expected[key], key + ' source column');
    });
    assert.equal(auto.ambiguities.length, 0, 'no ambiguity on the canonical export');
  });

  test('exact CPSI names outrank looser aliases', function () {
    var auto = UR.headerMapper.autoMap(['Service Code', 'visit_servicecd_key']);
    assert.equal(auto.mapping.service.header, 'visit_servicecd_key');
    assert.equal(auto.mapping.service.confidence, UR.headerMapper.CONFIDENCE.EXACT_CPSI);
  });

  test('recognizes common header variations', function () {
    var auto = UR.headerMapper.autoMap([
      'Medical Record Number', 'Account #', 'Patient Type', 'Admit Date', 'Admit Time',
      'Discharge Date', 'Discharge Time', 'Payor', 'Disposition Code', 'Admit Source'
    ]);
    assert.equal(auto.mapping.mrn.header, 'Medical Record Number');
    assert.equal(auto.mapping.account.header, 'Account #');
    assert.equal(auto.mapping.service.header, 'Patient Type');
    assert.equal(auto.mapping.insurance.header, 'Payor');
    assert.equal(auto.mapping.dischargeCode.header, 'Disposition Code');
    assert.equal(auto.mapping.admissionSource.header, 'Admit Source');
  });

  test('refuses to choose between two equally plausible columns', function () {
    var auto = UR.headerMapper.autoMap(['MRN', 'Medical Record Number', 'ipv1_num', 'visit_servicecd_key', 'ipv1_ad_date']);
    assert.equal(auto.mapping.mrn, null, 'MRN is left unmapped for the user to resolve');
    assert.ok(auto.ambiguities.length > 0, 'the tie is reported');
    assert.includes(auto.ambiguities[0].reason, 'equally well');
  });

  test('blocks processing when a required field is unmapped', function () {
    var auto = UR.headerMapper.autoMap(['ipv1_num', 'ipv1_ad_date']);
    var res = UR.headerMapper.validateMapping(auto.mapping, []);
    assert.notOk(res.ok, 'missing service code must block');
    var messages = res.blocking.map(function (b) { return b.message; }).join(' ');
    assert.includes(messages, 'Service code');
  });

  test('allows an explicit, acknowledged degradation instead', function () {
    var auto = UR.headerMapper.autoMap(['ipv1_num', 'visit_servicecd_key', 'ipv1_ad_date', 'ipv1_dis_date']);
    var blocked = UR.headerMapper.validateMapping(auto.mapping, []);
    assert.notOk(blocked.ok, 'unmapped MRN blocks by default');

    var allowed = UR.headerMapper.validateMapping(auto.mapping, ['mrn']);
    assert.ok(allowed.ok, 'proceeding is possible once the limitation is acknowledged');
    var degradedFields = allowed.degraded.map(function (d) { return d.field; });
    assert.ok(degradedFields.indexOf('mrn') >= 0, 'the degradation is recorded');
    assert.includes(allowed.degraded[0].effect + '', 'readmission');
  });

  test('rejects one column mapped to two canonical fields', function () {
    var mapping = {
      service: { header: 'X', index: 0, confidence: 1 },
      insurance: { header: 'X', index: 0, confidence: 1 },
      account: { header: 'A', index: 1, confidence: 1 },
      mrn: { header: 'M', index: 2, confidence: 1 },
      admitDate: { header: 'D', index: 3, confidence: 1 },
      dischargeDate: { header: 'E', index: 4, confidence: 1 }
    };
    var res = UR.headerMapper.validateMapping(mapping, []);
    assert.notOk(res.ok);
    assert.includes(res.blocking[0].message, 'mapped to both');
  });
});

describe('spreadsheet reading', function () {

  test('finds the header row beneath a report title', function () {
    var m = [
      ['Ad Hoc Report - Utilization Review', null, null],
      [],
      fixtures.HEADERS.slice(),
      fixtures.ROWS[0].slice()
    ];
    var table = UR.spreadsheetReader.matrixToTable(m);
    assert.equal(table.headers[0], 'visit_mr_num');
    assert.equal(table.rows.length, 1);
  });

  test('keeps the source row number for traceability', function () {
    var table = UR.spreadsheetReader.matrixToTable(fixtures.matrix());
    assert.equal(table.rows[0].sourceRowNumber, 2, 'first data row is spreadsheet row 2');
  });

  test('skips blank rows without dropping data rows', function () {
    var m = fixtures.matrix();
    m.splice(3, 0, [null, null, null]);
    var table = UR.spreadsheetReader.matrixToTable(m);
    assert.equal(table.rows.length, fixtures.ROWS.length);
  });
});

describe('multi-file import', function () {

  test('concatenates two files and collapses the identical overlap', function () {
    var config = fixtures.buildConfig(UR);
    var first = fixtures.buildSource(UR, { fileName: 'july.xlsx' });
    var second = fixtures.buildSource(UR, { fileName: 'august.xlsx' });
    var state = UR.pipeline.process([first, second], config, {
      periodStart: UR.util.mkDT(2026, 8, 1, 0, 0),
      periodEnd: UR.util.mkDT(2026, 8, 31, 0, 0)
    });
    assert.notOk(state.blocked, 'processing should complete');
    assert.equal(state.encounters.length, fixtures.ROWS.length - 1,
      'every row from the second file is an exact duplicate and is counted once');
    assert.ok(state.duplicatesRemoved > 0, 'the removals are reported, not silent');
  });
});

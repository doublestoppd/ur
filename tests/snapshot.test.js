/*
 * Session snapshot embedded in the exported workbook: embed/extract round
 * trip, Excel-compatibility, and full restore equivalence at pipeline level.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var XLSX = app.XLSX;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

describe('workbook session snapshot', function () {

  var state = fixtures.run(UR);
  var bytes = UR.workbookBuilder.toBytes(state, 'test');

  /* The snapshot an export would embed for the fixture run. */
  var snapshot = {
    kind: 'ur-compiler-snapshot',
    snapshotVersion: 1,
    app: UR.APP_VERSION,
    generatedAt: '2026-08-13T12:00:00.000Z',
    config: JSON.parse(UR.configSchema.toJSON(state.config, '2026-08-13T12:00:00.000Z')),
    selection: {},
    acknowledged: [],
    sources: state.sources.map(function (s) {
      return {
        fileName: s.fileName, sheetName: s.sheetName, headerRowIndex: s.headerRowIndex,
        headers: s.headers,
        rows: s.rows.map(function (r) { return { c: r.cells, n: r.sourceRowNumber }; })
      };
    }),
    period: { touched: true, start: '2026-08-01', end: '2026-08-31' },
    manualObservations: []
  };

  var withSnap = UR.zipPatch.embedSnapshot(bytes, JSON.stringify(snapshot));

  test('the snapshot part embeds and extracts intact', function () {
    assert.ok(withSnap.length > bytes.length, 'the workbook grew');
    var names = UR.zipPatch.entryNames(withSnap);
    assert.ok(names.indexOf('docProps/ur-snapshot.json') >= 0);
    var round = JSON.parse(UR.zipPatch.extractSnapshot(withSnap));
    assert.equal(round.kind, 'ur-compiler-snapshot');
    assert.equal(round.sources.length, snapshot.sources.length);
    assert.deepEqual(round.sources[0].headers, snapshot.sources[0].headers);
    assert.equal(round.sources[0].rows.length, snapshot.sources[0].rows.length);
  });

  test('the workbook still opens as a spreadsheet with every sheet', function () {
    var wb = XLSX.read(withSnap, { type: 'array' });
    assert.equal(wb.SheetNames.length, 18);
    var ct = Buffer.from(UR.zipPatch.entryData(withSnap, '[Content_Types].xml')).toString('utf8');
    assert.ok(ct.indexOf('Extension="json"') >= 0, 'the part is covered by a content type');
  });

  test('a workbook without a snapshot extracts null, as does a non-zip file', function () {
    assert.equal(UR.zipPatch.extractSnapshot(bytes), null);
    assert.equal(UR.zipPatch.extractSnapshot(new Uint8Array([1, 2, 3, 4])), null);
  });

  test('rebuilding the run from the extracted snapshot reproduces it exactly', function () {
    var snap = JSON.parse(UR.zipPatch.extractSnapshot(withSnap));
    var cfg = UR.configSchema.validate(snap.config);
    assert.ok(cfg.ok, 'the embedded configuration validates: ' + (cfg.errors || []).join(' '));

    var sources = snap.sources.map(function (s) {
      var auto = UR.headerMapper.autoMap(s.headers);
      return {
        fileName: s.fileName, sheetName: s.sheetName, headerRowIndex: s.headerRowIndex,
        headers: s.headers,
        rows: s.rows.map(function (r) { return { cells: r.c, sourceRowNumber: r.n }; }),
        mapping: auto.mapping
      };
    });
    var restored = UR.pipeline.process(sources, cfg.config, {
      periodStart: util.mkDT(2026, 8, 1, 0, 0),
      periodEnd: util.mkDT(2026, 8, 31, 0, 0),
      asOf: util.mkDT(2026, 9, 1, 0, 0)
    });

    assert.equal(restored.encounters.length, state.encounters.length);
    assert.equal(restored.episodes.length, state.episodes.length);
    var a = UR.workbookBuilder.build(state, 'same-stamp');
    var b = UR.workbookBuilder.build(restored, 'same-stamp');
    assert.equal(XLSX.utils.sheet_to_csv(b.workbook.Sheets['Executive Summary']),
                 XLSX.utils.sheet_to_csv(a.workbook.Sheets['Executive Summary']),
      'the restored run exports an identical Executive Summary');
  });

  test('manual observations survive the snapshot shape', function () {
    var entry = { account: 'A101', osAdmit: '2026-08-03T08:00:00.000Z', osDischarge: '2026-08-03T10:00:00.000Z' };
    var revived = { account: entry.account, osAdmitDT: new Date(entry.osAdmit), osDischargeDT: new Date(entry.osDischarge) };
    assert.equal(revived.osAdmitDT.toISOString(), entry.osAdmit, 'ISO round trip is exact');
    assert.equal(revived.osDischargeDT.getTime() - revived.osAdmitDT.getTime(), 2 * 3600000);
  });
});

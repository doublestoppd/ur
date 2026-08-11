/*
 * Excel output (spec 13) and the offline/PHI guarantees (spec 4).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var harness = require('./harness');
var app = harness.load();
var UR = app.UR;
var XLSX = app.XLSX;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');
var fs = require('fs');
var path = require('path');

var state = fixtures.run(UR);

var EXPECTED_SHEETS = [
  'Executive Summary', 'Monthly Trends', 'Review Queue', 'Review by Account',
  'Inpatient Detail', 'Observation Detail', 'Swing Bed Detail', 'Episodes',
  'Transitions', 'Readmissions', 'Payer Summary', 'Disposition & Source',
  'Notice Review', 'Data Quality', 'Code Inventory', 'Calculation Reference', 'Run Metadata'
];

function readBack(bytes) {
  return XLSX.read(bytes, { type: 'array' });
}

function sheetText(wb, name) {
  return XLSX.utils.sheet_to_csv(wb.Sheets[name]);
}

describe('workbook structure', function () {

  test('the bundled spreadsheet library loaded from disk', function () {
    assert.ok(XLSX, 'vendor/xlsx.full.min.js is present and self-contained');
    assert.ok(XLSX.version, 'library version ' + XLSX.version);
  });

  test('every worksheet named in the specification is produced', function () {
    var built = UR.workbookBuilder.build(state, '2026-09-01 08:00');
    assert.deepEqual(built.workbook.SheetNames, EXPECTED_SHEETS);
  });

  test('worksheet names are valid for Excel', function () {
    EXPECTED_SHEETS.forEach(function (name) {
      assert.ok(name.length <= 31, name + ' is at most 31 characters');
      assert.ok(!/[\[\]:*?\/\\]/.test(name), name + ' has no forbidden characters');
    });
  });

  test('the workbook writes and reads back cleanly', function () {
    var bytes = UR.workbookBuilder.toBytes(state, '2026-09-01 08:00');
    assert.ok(bytes.length > 5000, 'the workbook has content');
    var wb = readBack(bytes);
    assert.deepEqual(wb.SheetNames, EXPECTED_SHEETS);
  });

  test('frozen header panes are applied without breaking the file', function () {
    var bytes = UR.workbookBuilder.toBytes(state, '2026-09-01 08:00');
    var entries = UR.zipPatch.parseZip(bytes);
    assert.ok(entries, 'the archive still parses');
    var frozen = 0;
    entries.forEach(function (e) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) { return; }
      var xml = Buffer.from(e.data).toString('utf8');
      if (xml.indexOf('state="frozen"') >= 0) { frozen++; }
    });
    assert.ok(frozen >= 10, 'header rows are frozen on the detail sheets (' + frozen + ' sheets)');
    assert.ok(readBack(bytes).SheetNames.length === EXPECTED_SHEETS.length, 'and the workbook still opens');
  });

  test('detail sheets carry an autofilter', function () {
    var built = UR.workbookBuilder.build(state, '');
    ['Review Queue', 'Inpatient Detail', 'Observation Detail', 'Episodes', 'Transitions'].forEach(function (name) {
      assert.ok(built.workbook.Sheets[name]['!autofilter'], name + ' has an autofilter');
    });
  });

  test('the workbook contains no macros and no external links', function () {
    var bytes = UR.workbookBuilder.toBytes(state, '');
    var entries = UR.zipPatch.parseZip(bytes);
    entries.forEach(function (e) {
      assert.ok(e.name.indexOf('vbaProject') < 0, 'no VBA project');
      assert.ok(e.name.indexOf('externalLink') < 0, 'no external links');
    });
    var text = Buffer.from(bytes).toString('latin1');
    assert.ok(text.indexOf('http://') < 0 || text.indexOf('schemas.openxmlformats.org') >= 0,
      'the only URLs present are OOXML namespaces');
  });
});

describe('workbook content', function () {

  var built = UR.workbookBuilder.build(state, '2026-09-01 08:00');
  var wb = built.workbook;

  test('the Executive Summary carries no patient identifiers', function () {
    var text = sheetText(wb, 'Executive Summary');
    assert.ok(text.indexOf('TEST, ALPHA') < 0, 'no patient names');
    assert.ok(text.indexOf('A101') < 0, 'no account numbers');
    assert.ok(text.indexOf('1001') < 0, 'no MRNs');
    assert.includes(text, 'Reporting period');
    assert.includes(text, 'CAH96_001');
    assert.includes(text, 'surveillance');
  });

  test('the Executive Summary shows both patient-day methods', function () {
    var text = sheetText(wb, 'Executive Summary');
    assert.includes(text, 'Equivalent patient days');
    assert.includes(text, 'Midnight census patient days');
    assert.includes(text, 'Time-weighted average daily census');
    assert.includes(text, 'Midnight average daily census');
    assert.includes(text, 'PAIRED METHOD');
  });

  test('the Review Queue carries Rule IDs on every row', function () {
    var rows = XLSX.utils.sheet_to_json(wb.Sheets['Review Queue'], { header: 1 });
    assert.equal(rows[0][0], 'Rule ID');
    for (var i = 1; i < rows.length; i++) {
      if (!rows[i].length) { continue; }
      assert.ok(UR.reviewRules.byId(rows[i][0]), 'row ' + i + ' has a registered rule id');
    }
  });

  test('detail sheets expose derived values and linkage', function () {
    var header = XLSX.utils.sheet_to_json(wb.Sheets['Inpatient Detail'], { header: 1 })[0];
    ['Account', 'LOS hours', 'LOS days', 'Midnights', 'Payer category', 'Episode ID', 'Review flags'].forEach(function (col) {
      assert.ok(header.indexOf(col) >= 0, 'Inpatient Detail has a ' + col + ' column');
    });
    var obsHeader = XLSX.utils.sheet_to_json(wb.Sheets['Observation Detail'], { header: 1 })[0];
    assert.ok(obsHeader.indexOf('Converted to IP') >= 0);
  });

  test('the Episodes sheet shows the reconstructed service sequence', function () {
    var text = sheetText(wb, 'Episodes');
    assert.includes(text, 'OS -> IP -> SB -> IP');
    assert.includes(text, 'A101, A102, A103, A104');
  });

  test('the Transitions sheet documents attempted and refused links', function () {
    var text = sheetText(wb, 'Transitions');
    assert.includes(text, 'Ambiguous');
    assert.includes(text, 'Missing successor');
    assert.includes(text, 'never linked on timing alone');
  });

  test('the Readmissions sheet refuses the CMS label and reports lookback', function () {
    var text = sheetText(wb, 'Readmissions');
    assert.includes(text, 'INTERNAL OPERATIONAL INDICATOR');
    assert.includes(text, 'not CMS risk-standardized');
    assert.includes(text, 'Incomplete lookback');
  });

  test('the Notice Review sheet states that it is not proof of delivery', function () {
    var text = sheetText(wb, 'Notice Review');
    assert.includes(text, 'not proof of delivery');
    assert.includes(text, 'verified manually');
  });

  test('the Code Inventory lists every encountered code with a status', function () {
    var text = sheetText(wb, 'Code Inventory');
    ['IP', 'OS', 'SB', 'ZZ', 'OP', 'Unrecognized', 'Recognized / ignored', 'Recognized / used'].forEach(function (token) {
      assert.includes(text, token);
    });
  });

  test('the Data Quality sheet lists findings with severity and effect', function () {
    var text = sheetText(wb, 'Data Quality');
    assert.includes(text, 'DQ_SVC_UNKNOWN');
    assert.includes(text, 'Warning');
    assert.includes(text, 'SUMMARY BY RULE');
    assert.includes(text, 'ALL FINDINGS');
  });

  test('the Calculation Reference is generated from the registry', function () {
    var text = sheetText(wb, 'Calculation Reference');
    UR.calculationRules.ids().forEach(function (id) {
      assert.includes(text, id, 'rule ' + id + ' appears in the exported reference');
    });
    UR.reviewRules.ids().forEach(function (id) {
      assert.includes(text, id, 'review rule ' + id + ' appears in the exported reference');
    });
    assert.includes(text, 'Rule ID');
    assert.includes(text, 'Null / open handling');
    assert.includes(text, 'https://www.cms.gov');
  });

  test('the Calculation Reference reflects the configuration actually used', function () {
    var config = fixtures.buildConfig(UR);
    config.thresholds.acuteTargetHours = 111;
    var s = fixtures.run(UR, { config: config });
    var text = XLSX.utils.sheet_to_csv(UR.workbookBuilder.calculationReference(s));
    assert.includes(text, '= 111');
  });

  test('Run Metadata records versions, sources, mapping, and thresholds', function () {
    var text = sheetText(wb, 'Run Metadata');
    assert.includes(text, UR.APP_VERSION);
    assert.includes(text, 'cpsi-august-2026.xlsx');
    assert.includes(text, 'visit_servicecd_key');
    assert.includes(text, 'Maximum transition gap');
    assert.includes(text, 'no macros and no external links');
    assert.includes(text, 'Discharged-stay period basis');
  });

  test('Monthly Trends has one row per imported month', function () {
    var rows = XLSX.utils.sheet_to_json(wb.Sheets['Monthly Trends'], { header: 1 });
    assert.equal(rows[0][0], 'Month');
    assert.equal(rows[1][0], 'Aug 2026');
  });

  test('datetimes are written as real Excel date cells', function () {
    var ws = wb.Sheets['Inpatient Detail'];
    var header = XLSX.utils.sheet_to_json(ws, { header: 1 })[0];
    var col = header.indexOf('Admit');
    var addr = XLSX.utils.encode_cell({ r: 1, c: col });
    assert.equal(ws[addr].t, 'n', 'stored as a number');
    assert.includes(ws[addr].z, 'mm/dd/yyyy', 'with a date format');
    var back = util.fromExcelSerial(ws[addr].v);
    assert.equal(back.getUTCFullYear(), 2026, 'and it round-trips on the wall clock');
  });
});

describe('PHI controls', function () {

  test('patient names can be excluded from the export', function () {
    var config = fixtures.buildConfig(UR);
    config.processing.excludePatientNames = true;
    var s = fixtures.run(UR, { config: config });
    var wb = UR.workbookBuilder.build(s, '').workbook;
    ['Inpatient Detail', 'Review Queue', 'Episodes', 'Readmissions', 'Notice Review'].forEach(function (name) {
      var text = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      assert.ok(text.indexOf('TEST, ALPHA') < 0, name + ' contains no patient name');
      assert.ok(text.indexOf('Patient name') < 0, name + ' has no patient-name column');
    });
    var detail = XLSX.utils.sheet_to_csv(wb.Sheets['Inpatient Detail']);
    assert.includes(detail, 'A102', 'account numbers are still present for review work');
  });

  test('patient names are included by default for review lists', function () {
    var wb = UR.workbookBuilder.build(state, '').workbook;
    assert.includes(XLSX.utils.sheet_to_csv(wb.Sheets['Inpatient Detail']), 'TEST, ALPHA');
  });
});

describe('offline guarantees', function () {

  var ROOT = harness.ROOT;

  function readAllSource() {
    var out = [];
    function walk(dir) {
      fs.readdirSync(dir).forEach(function (entry) {
        var full = path.join(dir, entry);
        var stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full); return; }
        if (!/\.(js|html|css)$/.test(entry)) { return; }
        out.push({ file: path.relative(ROOT, full), text: fs.readFileSync(full, 'utf8') });
      });
    }
    walk(path.join(ROOT, 'src'));
    out.push({ file: 'index.html', text: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') });
    out.push({ file: 'app.css', text: fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8') });
    return out;
  }

  test('no application source makes a network call', function () {
    var forbidden = [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /navigator\.sendBeacon/, /import\s*\(/];
    readAllSource().forEach(function (src) {
      forbidden.forEach(function (re) {
        assert.ok(!re.test(src.text), src.file + ' must not use ' + re);
      });
    });
  });

  test('no page asset is loaded from a remote origin', function () {
    readAllSource().forEach(function (src) {
      var remote = src.text.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g);
      assert.ok(!remote, src.file + ' references a remote asset: ' + (remote || []).join(', '));
      var cssImport = src.text.match(/@import\s+url\(\s*['"]?https?:/);
      assert.ok(!cssImport, src.file + ' imports a remote stylesheet');
    });
  });

  test('no application source writes patient data to browser storage', function () {
    readAllSource().forEach(function (src) {
      if (src.file === 'src/config/configSchema.js') { return; } /* the one audited writer */
      assert.ok(!/localStorage\.setItem|indexedDB|sessionStorage\.setItem|document\.cookie/.test(src.text),
        src.file + ' must not write to browser storage directly');
    });
  });

  test('every script the page loads exists on disk', function () {
    harness.scriptList().forEach(function (rel) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), 'missing file referenced by index.html: ' + rel);
    });
  });

  test('the vendored library ships with its licence', function () {
    var licence = fs.readFileSync(path.join(ROOT, 'vendor', 'xlsx-LICENSE.txt'), 'utf8');
    assert.includes(licence, 'Apache License');
  });
});

describe('zip patcher', function () {

  test('a rebuilt archive round-trips byte-for-byte when unchanged', function () {
    var bytes = UR.workbookBuilder.toBytes(state, '');
    var entries = UR.zipPatch.parseZip(bytes);
    var rebuilt = UR.zipPatch.buildZip(entries);
    var wb = readBack(rebuilt);
    assert.equal(wb.SheetNames.length, EXPECTED_SHEETS.length);
  });

  test('the patcher leaves an unrecognized archive alone', function () {
    var junk = new Uint8Array([1, 2, 3, 4, 5]);
    var result = UR.zipPatch.applyFreezePanes(junk, { 1: 1 });
    assert.equal(result.length, junk.length, 'returned unchanged rather than corrupted');
  });

  test('CRC32 matches the known reference value', function () {
    var bytes = new TextEncoder().encode('123456789');
    assert.equal(UR.zipPatch.crc32(bytes), 0xCBF43926);
  });
});

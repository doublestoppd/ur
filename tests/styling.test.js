/*
 * The workbook styling pass (zipPatch.applyWorkbookPolish).
 *
 * Two promises: the styled file stays a valid workbook that reads back with
 * every value intact, and every failure path degrades to the unstyled bytes
 * rather than a corrupted file.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var XLSX = app.XLSX;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);
var bytes = UR.workbookBuilder.toBytes(state, '2026-09-01 08:00');
var entries = UR.zipPatch.parseZip(bytes);

function entryXml(name) {
  var e = entries.filter(function (x) { return x.name === name; })[0];
  return e ? Buffer.from(e.data).toString('utf8') : null;
}

/* Sheet order: 1 Contents, 2 Exec Summary, 3 Monthly, 4 Review Queue, ... */
function sheetXml(n) { return entryXml('xl/worksheets/sheet' + n + '.xml'); }

describe('workbook styling', function () {

  test('styles.xml carries the Arial font set, fills, and named formats', function () {
    var styles = entryXml('xl/styles.xml');
    assert.includes(styles, '<name val="Arial"/>');
    assert.includes(styles, 'FF1D4E79', 'the accent header fill exists');
    assert.includes(styles, 'FFF2F5F8', 'the zebra fill exists');
    assert.notOk(/<name val="Calibri"\/>/.test(styles), 'the default font is replaced');
  });

  test('the styled workbook still reads back with all sheets and values', function () {
    var wb = XLSX.read(bytes, { type: 'array' });
    assert.equal(wb.SheetNames.length, 18);
    var text = XLSX.utils.sheet_to_csv(wb.Sheets['Executive Summary']);
    assert.includes(text, 'CAH ACUTE INPATIENT', 'metric content survives the styling pass');
  });

  test('every sheet tab carries a group color', function () {
    for (var n = 1; n <= 18; n++) {
      assert.ok(/<tabColor rgb="FF[0-9A-F]{6}"\/>/.test(sheetXml(n)), 'sheet ' + n + ' has a tab color');
    }
  });

  test('header rows are styled and data rows are zebra-banded', function () {
    var rq = sheetXml(4); /* Review Queue: header row 1, data below */
    var header = /<row r="1"[^>]*>([\s\S]*?)<\/row>/.exec(rq)[1];
    assert.ok(/<c r="A1" s="\d+"/.test(header), 'the header row carries a style');
    /*
     * Compare the first cell of two adjacent data rows: the banded row's text
     * cell carries a zebra style; the unbanded row's text cell carries none
     * (date cells keep the library's own format either way).
     */
    assert.ok(/<c r="A3" s="\d+"/.test(rq), 'row 3 first cell is banded');
    assert.notOk(/<c r="A2" s="\d+"/.test(rq), 'row 2 first cell is not banded');
  });

  test('a banded date cell keeps its date number format', function () {
    /*
     * The zebra style is a variant of the cell format the library assigned,
     * so the numFmtId must survive. Read the workbook back and confirm the
     * Admit column in a banded Inpatient Detail row still parses as a date.
     */
    var wb = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true });
    var ip = wb.Sheets['Inpatient Detail'];
    var header = [];
    var col = null;
    for (var c = 0; c < 40; c++) {
      var cell = ip[XLSX.utils.encode_cell({ r: 0, c: c })];
      if (cell && cell.v === 'Admit') { col = c; break; }
    }
    assert.ok(col !== null, 'the Admit column exists');
    var banded = ip[XLSX.utils.encode_cell({ r: 2, c: col })];
    assert.ok(banded && banded.t === 'n', 'the banded admit cell is numeric');
    assert.includes(banded.z || '', 'yyyy', 'and still formatted as a date: ' + banded.z);
  });

  test('the Contents sheet links to every other worksheet', function () {
    var contents = sheetXml(1);
    var links = contents.match(/<hyperlink /g) || [];
    assert.equal(links.length, 17, 'one link per worksheet');
    assert.includes(contents, "location=\"&apos;Data Quality&apos;!A1\"");
  });

  test('severity cells on the Data Quality sheet are styled by value', function () {
    var styles = entryXml('xl/styles.xml');
    var dq = sheetXml(15);
    /* The fixture run raises warnings: their cells must not use the default format. */
    var firstFinding = /<row r="3"[^>]*><c r="A3" s="(\d+)"/.exec(dq);
    assert.ok(firstFinding, 'the first summary row severity cell is styled');
    assert.ok(Number(firstFinding[1]) > 1, 'with an appended style, not a library default');
    assert.includes(styles, 'FFFDF7E3', 'the warning tint exists in the style sheet');
  });

  test('junk bytes and foreign zips fall back to the original bytes', function () {
    /* Content compare rather than identity: the harness runs the app in a VM
     * realm, so a same-realm instanceof check re-wraps the array there. */
    var junk = new Uint8Array([1, 2, 3, 4, 5]);
    assert.deepEqual(Array.from(UR.zipPatch.applyWorkbookPolish(junk, { sheets: {} })), [1, 2, 3, 4, 5]);
    var unstyled = new Uint8Array(XLSX.write(UR.workbookBuilder.build(state, '').workbook,
      { bookType: 'xlsx', type: 'array', compression: false }));
    var styled = UR.zipPatch.applyWorkbookPolish(unstyled, { sheets: {} });
    var wb = XLSX.read(styled, { type: 'array' });
    assert.equal(wb.SheetNames.length, 18, 'an empty plan still yields a readable workbook');
  });

  test('patchStylesXml refuses XML it does not recognize', function () {
    assert.equal(UR.zipPatch.patchStylesXml('<xml>not a stylesheet</xml>'), null);
  });
});

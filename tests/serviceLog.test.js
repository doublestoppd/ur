/*
 * The CPSI Service Log (CNSERVLOG) PDF path: the self-contained inflate,
 * the PDF text extractor, the report parser, and the pipeline application
 * of parsed OS -> IP changes as observation segments.
 */
'use strict';

var zlib = require('zlib');
var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

describe('inflate', function () {

  test('round-trips Node zlib deflate output, all block types', function () {
    var cases = [
      Buffer.from('hello world'),
      Buffer.from('a'.repeat(5000) + 'b'.repeat(5000)),
      Buffer.from(Array.from({ length: 4096 }, function (_, i) { return i % 251; })),
      zlib.deflateSync(Buffer.from('x')).length && Buffer.from('CPSI SERVICE LOG '.repeat(300))
    ];
    cases.forEach(function (buf) {
      var deflated = new Uint8Array(zlib.deflateSync(buf));
      var out = UR.inflate.zlib(deflated);
      assert.equal(Buffer.from(out).toString('latin1'), buf.toString('latin1'));
    });
    /* stored (uncompressed) blocks too */
    var stored = new Uint8Array(zlib.deflateSync(Buffer.from('stored-block test'), { level: 0 }));
    assert.equal(Buffer.from(UR.inflate.zlib(stored)).toString(), 'stored-block test');
  });

  test('rejects garbage instead of hanging', function () {
    var threw = false;
    try { UR.inflate.zlib(new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff])); }
    catch (e) { threw = true; }
    assert.ok(threw);
  });
});

/* A minimal single-page PDF carrying the given content stream, Flate-compressed
 * like real CPSI output. */
function makePdf(contentText) {
  var content = zlib.deflateSync(Buffer.from(contentText, 'latin1'));
  var head = '%PDF-1.4\n';
  var obj = '1 0 obj\n<</Length ' + content.length + ' /Filter /FlateDecode>>\nstream\n';
  var tail = '\nendstream\nendobj\ntrailer\n<<>>\n%%EOF\n';
  return new Uint8Array(Buffer.concat([Buffer.from(head + obj, 'latin1'), content, Buffer.from(tail, 'latin1')]));
}

var REPORT_LINES = [
  'RUN DATE: 08/14/26               CHICOT MEMORIAL MEDICAL CENTER                  PAGE   1',
  '    TIME: 08:45    SERVICE LOG FOR SERVICE CD             06/01/26-06/30/26       CNSERVLOG',
  '                   CHANGED FROM: OS',
  '-------------------CHANGED-TO:---IP         -           -           -           -',
  '  PAT NUM   PAT NAME                FROM             TO                DATE   TIME   INITIALS',
  '  80180009  PATIENT ALPHA A         OS               IP              6/06/26  13:10     WBB',
  '  80180259  PATIENT BRAVO B         OS               IP              6/12/26  08:18     SCD',
  '  80180644  PATIENT CHARLIE C       SB               IP              6/21/26  11:37     WBB'
];

function reportContent() {
  var ops = ['BT', '/F1 10 Tf', '0.6 0 0 1 43 744 Tm', '11 TL'];
  REPORT_LINES.forEach(function (line, i) {
    var esc = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    ops.push(i === 0 ? '(' + esc + ')Tj' : '(' + esc + ')\'');
  });
  ops.push('ET');
  return ops.join('\n');
}

describe('pdf text extraction', function () {

  test('extracts the report lines from a Flate-compressed PDF', function () {
    var lines = UR.pdfText.extractLines(makePdf(reportContent()));
    assert.equal(lines.length, REPORT_LINES.length);
    assert.includes(lines[0], 'RUN DATE: 08/14/26');
    assert.includes(lines[5], '80180009');
    assert.includes(lines[5], '6/06/26  13:10');
  });

  test('positions strings drawn with Td/Tm onto the same visual line', function () {
    var content = 'BT /F1 10 Tf 1 0 0 1 43 700 Tm (LEFT)Tj 100 0 Td (RIGHT)Tj 1 0 0 1 43 689 Tm (BELOW)Tj ET';
    var lines = UR.pdfText.extractLines(makePdf(content));
    assert.equal(lines.length, 2);
    assert.includes(lines[0], 'LEFT');
    assert.includes(lines[0], 'RIGHT');
    assert.equal(lines[1], 'BELOW');
  });

  test('a non-PDF and a textless PDF both yield nothing', function () {
    assert.deepEqual(UR.pdfText.extractLines(new Uint8Array([1, 2, 3])), []);
    assert.deepEqual(UR.pdfText.extractLines(makePdf('q 1 0 0 1 0 0 cm Q')), []);
  });
});

describe('service log parser', function () {

  var parsed = UR.serviceLogParser.parse(REPORT_LINES);

  test('recognizes the report and its metadata', function () {
    assert.ok(parsed.ok);
    assert.equal(parsed.facility, 'CHICOT MEMORIAL MEDICAL CENTER');
    assert.equal(parsed.reportRange, '06/01/26 - 06/30/26');
  });

  test('parses every change row with the change moment', function () {
    assert.equal(parsed.rows.length, 3);
    var r = parsed.rows[0];
    assert.equal(r.account, '80180009');
    assert.equal(r.name, 'PATIENT ALPHA A');
    assert.equal(r.from, 'OS');
    assert.equal(r.to, 'IP');
    assert.equal(r.changeDT.toISOString(), '2026-06-06T13:10:00.000Z');
    assert.equal(parsed.rows[2].from, 'SB', 'other service pairs parse too; the caller filters');
  });

  test('refuses lines that are not the report', function () {
    assert.ok(!UR.serviceLogParser.parse(['random text', 'more text']).ok);
  });
});

describe('pipeline application of service-log changes', function () {

  test('an OS -> IP change becomes an observation segment from the account opening', function () {
    var s = fixtures.run(UR, {
      matrix: [
        fixtures.HEADERS.slice(),
        [61, '80180009', 'PATIENT ALPHA A', 'IP', '06/06/2026', 415, '06/09/2026', 1000, 'MCR', 'H', 1]
      ],
      periodStart: util.mkDT(2026, 6, 1, 0, 0),
      periodEnd: util.mkDT(2026, 6, 30, 0, 0),
      asOf: util.mkDT(2026, 7, 1, 0, 0),
      manualObservations: [{
        account: '80180009',
        osAdmitDT: null, /* the Service Log supplies only the change moment */
        osDischargeDT: util.mkDT(2026, 6, 6, 13, 10),
        source: 'from the CPSI Service Log report test.pdf'
      }]
    });
    var os = s.encounters.find(function (e) { return e.account === '80180009-MANUAL'; });
    assert.ok(os, 'the observation segment exists');
    assert.equal(os.admitDT.toISOString(), '2026-06-06T04:15:00.000Z', 'observation begins at the account opening');
    assert.equal(os.dischargeDT.toISOString(), '2026-06-06T13:10:00.000Z', 'and ends at the change moment');
    var ip = s.encounters.find(function (e) { return e.account === '80180009'; });
    assert.equal(ip.admitDT.toISOString(), '2026-06-06T13:10:00.000Z', 'the inpatient admission is the change moment');
    assert.equal(s.metrics.observation.OSIP_001.value, 1);
    var note = s.diagnostics.all().find(function (d) { return d.ruleId === 'DQ_MANUAL_OS'; });
    assert.includes(note.message, 'Service Log', 'the note names the report as the source');
  });
});

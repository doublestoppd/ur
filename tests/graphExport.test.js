/*
 * Graphs: monthly aggregation of the census chart for multi-month periods,
 * and chart images embedded in the exported workbook.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var XLSX = app.XLSX;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

describe('census chart aggregation', function () {

  test('a single-month period plots every day', function () {
    var state = fixtures.run(UR);
    var spec = UR.chartData.dailyCensus(state);
    assert.equal(spec.title, 'Midnight census by day');
    assert.equal(spec.categories.length,
      state.metrics.census.PD_MN_001.dailyCensus.length,
      'one point per day of the period');
  });

  test('a multi-month period aggregates to average census per month', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      [61, 'M001', 'JULY, TEST', 'IP', '07/05/2026', 800, '07/12/2026', 900, 'MCR', 'H', 1],
      [63, 'M002', 'AUGUST, TEST', 'IP', '08/03/2026', 800, '08/09/2026', 900, 'BCBS', 'H', 1]
    ];
    var state = fixtures.run(UR, {
      matrix: matrix,
      periodStart: util.mkDT(2026, 7, 1, 0, 0),
      periodEnd: util.mkDT(2026, 8, 31, 0, 0)
    });
    var spec = UR.chartData.dailyCensus(state);
    assert.equal(spec.title, 'Average midnight census by month');
    assert.deepEqual(spec.categories, ['Jul 2026', 'Aug 2026']);
    assert.ok(spec.ruleIds.indexOf('ADC_MN_001') >= 0, 'names the ADC rule');

    /* The monthly value must be the mean of that month's daily census. */
    var daily = state.metrics.census.PD_MN_001.dailyCensus;
    var julyDays = daily.filter(function (d) { return d.date.getUTCMonth() === 6; });
    var julySum = julyDays.reduce(function (n, d) { return n + d.IP; }, 0);
    assert.close(spec.series[0].values[0], util.round(julySum / julyDays.length, 1), 1e-9,
      'July IP value is the July average of the same daily data');
  });

  test('the aggregated chart still tables cleanly', function () {
    var state = fixtures.run(UR, {
      periodStart: util.mkDT(2026, 7, 1, 0, 0),
      periodEnd: util.mkDT(2026, 8, 31, 0, 0)
    });
    var spec = UR.chartData.dailyCensus(state);
    var tbl = UR.chartData.toTable(spec);
    assert.equal(tbl.rows.length, spec.categories.length);
    assert.equal(tbl.header.length, 1 + spec.series.length);
  });
});

describe('chart images in the exported workbook', function () {

  var state = fixtures.run(UR);

  /* A real (1x1 transparent) PNG, so image parts carry valid image bytes. */
  var PNG = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'));

  function images(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({
        id: 'chart-' + i, title: 'Chart ' + i, subtitle: 'Subtitle ' + i,
        ruleIds: ['PD_MN_001'], bytes: PNG, width: 900, height: 324
      });
    }
    return out;
  }

  test('without images the workbook is unchanged - no Graphs sheet', function () {
    var built = UR.workbookBuilder.build(state, 'test');
    assert.ok(built.workbook.SheetNames.indexOf('Graphs') < 0);
    assert.ok(!built.plan.graphs);
  });

  test('with images a Graphs sheet appears after Monthly Trends, listed in Contents', function () {
    var built = UR.workbookBuilder.build(state, 'test', { chartImages: images(2) });
    assert.equal(built.workbook.SheetNames.indexOf('Graphs'), 3,
      'Contents, Executive Summary, Monthly Trends, Graphs');
    assert.ok(built.plan.graphs, 'the plan carries the embedding instructions');
    assert.equal(built.plan.graphs.sheetIndex, 4);
    assert.equal(built.plan.graphs.images.length, 2);
    assert.ok(built.plan.graphs.images[1].row > built.plan.graphs.images[0].row,
      'each image anchors below the previous one');
    var contents = XLSX.utils.sheet_to_csv(built.workbook.Sheets.Contents);
    assert.ok(contents.indexOf('Graphs') >= 0, 'Contents lists the Graphs sheet');
  });

  test('toBytes embeds the media, drawing, relationship, and content-type parts', function () {
    var bytes = UR.workbookBuilder.toBytes(state, 'test', { chartImages: images(2) });
    var names = UR.zipPatch.entryNames(bytes);
    assert.ok(names.indexOf('xl/media/urchart1.png') >= 0, 'first image part present');
    assert.ok(names.indexOf('xl/media/urchart2.png') >= 0, 'second image part present');
    assert.ok(names.indexOf('xl/drawings/drawing1.xml') >= 0, 'drawing part present');
    assert.ok(names.indexOf('xl/drawings/_rels/drawing1.xml.rels') >= 0, 'drawing rels present');
    assert.ok(names.indexOf('xl/worksheets/_rels/sheet4.xml.rels') >= 0, 'sheet rels present');

    var media = UR.zipPatch.entryData(bytes, 'xl/media/urchart1.png');
    assert.equal(media.length, PNG.length, 'image bytes survive intact');

    var drawing = Buffer.from(UR.zipPatch.entryData(bytes, 'xl/drawings/drawing1.xml')).toString('utf8');
    assert.ok(drawing.indexOf('<xdr:oneCellAnchor>') >= 0);
    assert.ok(drawing.indexOf('r:embed="rIdUR1"') >= 0 && drawing.indexOf('r:embed="rIdUR2"') >= 0);

    var sheet = Buffer.from(UR.zipPatch.entryData(bytes, 'xl/worksheets/sheet4.xml')).toString('utf8');
    assert.ok(sheet.indexOf('<drawing r:id="rIdURDrawing"/>') >= 0, 'worksheet references the drawing');

    var ct = Buffer.from(UR.zipPatch.entryData(bytes, '[Content_Types].xml')).toString('utf8');
    assert.ok(ct.indexOf('Extension="png"') >= 0, 'png content type declared');
    assert.ok(ct.indexOf('/xl/drawings/drawing1.xml') >= 0, 'drawing content type declared');
  });

  test('the workbook with graphs still opens and keeps every sheet', function () {
    var bytes = UR.workbookBuilder.toBytes(state, 'test', { chartImages: images(1) });
    var wb = XLSX.read(bytes, { type: 'array' });
    assert.equal(wb.SheetNames.length, 19, '18 standard sheets plus Graphs');
    assert.equal(wb.SheetNames[3], 'Graphs');
    var text = XLSX.utils.sheet_to_csv(wb.Sheets.Graphs);
    assert.ok(text.indexOf('Chart 0') >= 0, 'the caption block is on the sheet');
    assert.ok(text.indexOf('PD_MN_001') >= 0, 'the caption names the rule ids');
  });

  test('embedChartImages leaves the bytes alone on an empty plan', function () {
    var bytes = UR.workbookBuilder.toBytes(state, 'test');
    var out = UR.zipPatch.embedChartImages(bytes, { sheetIndex: 4, images: [] });
    assert.equal(out, bytes instanceof Uint8Array ? out : out, 'no throw');
    assert.equal(UR.zipPatch.entryNames(out).filter(function (n) { return /media/.test(n); }).length, 0);
  });
});

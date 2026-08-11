/*
 * Date, time, and wall-clock arithmetic (spec 9.1, 11.2).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var parsers = UR.parsers;

describe('parsers - dates', function () {

  test('reads US, ISO, compact, and month-name text dates', function () {
    var cases = [
      ['08/03/2026', 2026, 8, 3],
      ['8/3/26', 2026, 8, 3],
      ['2026-08-03', 2026, 8, 3],
      ['08-03-2026', 2026, 8, 3],
      ['20260803', 2026, 8, 3],
      ['3 Aug 2026', 2026, 8, 3],
      ['Aug 3, 2026', 2026, 8, 3]
    ];
    cases.forEach(function (c) {
      var r = parsers.parseDate(c[0]);
      assert.ok(r.ok, 'should parse ' + c[0] + (r.ok ? '' : ': ' + r.reason));
      assert.equal(r.value.getUTCFullYear(), c[1], c[0] + ' year');
      assert.equal(r.value.getUTCMonth() + 1, c[2], c[0] + ' month');
      assert.equal(r.value.getUTCDate(), c[3], c[0] + ' day');
    });
  });

  test('reads Excel serial dates on the wall clock', function () {
    /* 46236 = 2026-08-03 in the 1900 date system. */
    var serial = util.toExcelSerial(util.mkDT(2026, 8, 3, 0, 0));
    var r = parsers.parseDate(serial);
    assert.ok(r.ok, 'serial should parse');
    assert.equal(util.fmtDate(r.value), '08/03/2026');
  });

  test('extracts a time component carried inside a date cell', function () {
    var serial = util.toExcelSerial(util.mkDT(2026, 8, 3, 14, 32));
    var r = parsers.parseDate(serial);
    assert.ok(r.ok);
    assert.equal(r.timeFromDate, 14 * 60 + 32, 'minutes recovered from the serial fraction');

    var t = parsers.parseDate('08/03/2026 14:32');
    assert.ok(t.ok);
    assert.equal(t.timeFromDate, 14 * 60 + 32, 'minutes recovered from combined text');
  });

  test('rejects impossible and unreadable dates with a reason', function () {
    assert.notOk(parsers.parseDate('02/30/2026').ok, 'February 30 is impossible');
    assert.notOk(parsers.parseDate('not a date').ok);
    assert.notOk(parsers.parseDate('').ok);
    assert.notOk(parsers.parseDate(null).ok);
    assert.includes(parsers.parseDate('13/45/2026').reason, 'impossible');
  });

  test('two-digit years split at 70', function () {
    assert.equal(parsers.parseDate('01/01/69').value.getUTCFullYear(), 2069);
    assert.equal(parsers.parseDate('01/01/70').value.getUTCFullYear(), 1970);
  });
});

describe('parsers - times', function () {

  test('reads military, colon, and meridiem times', function () {
    var cases = [
      [1432, 14 * 60 + 32],
      ['1432', 14 * 60 + 32],
      ['0832', 8 * 60 + 32],
      [832, 8 * 60 + 32],
      ['14:32', 14 * 60 + 32],
      ['2:32 PM', 14 * 60 + 32],
      ['12:00 AM', 0],
      ['12:00 PM', 12 * 60],
      ['14:32:07', 14 * 60 + 32],
      [0, 0],
      ['0000', 0],
      ['2400', 0]
    ];
    cases.forEach(function (c) {
      var r = parsers.parseTime(c[0]);
      assert.ok(r.ok, 'should parse ' + c[0] + (r.ok ? '' : ': ' + r.reason));
      assert.equal(r.value, c[1], 'minutes for ' + c[0]);
    });
  });

  test('treats a bare 1-2 digit value as an hour, not as minutes', function () {
    /* CPSI writes 00:10 as "0010". A numeric cell holding 10 has lost its
     * leading zeros, so it is read as 10:00 - the only reading that keeps
     * "8" meaning 08:00. Values above 23 in that shape are refused rather
     * than guessed. */
    assert.equal(parsers.parseTime('0010').value, 10, '"0010" is 00:10');
    assert.equal(parsers.parseTime(10).value, 600, '10 is 10:00');
    assert.equal(parsers.parseTime(8).value, 480, '8 is 08:00');
    assert.notOk(parsers.parseTime(45).ok, '45 is neither an hour nor a readable time');
  });

  test('reads an Excel time fraction', function () {
    var r = parsers.parseTime(0.6055555555);
    assert.ok(r.ok);
    assert.equal(r.value, 14 * 60 + 32);
  });

  test('rejects out-of-range and unreadable times', function () {
    assert.notOk(parsers.parseTime('2561').ok);
    assert.notOk(parsers.parseTime('99:99').ok);
    assert.notOk(parsers.parseTime('lunchtime').ok);
    assert.notOk(parsers.parseTime('').ok);
  });
});

describe('util - wall-clock arithmetic', function () {

  test('elapsed hours are the written clock difference', function () {
    var a = util.mkDT(2026, 8, 4, 14, 32);
    var b = util.mkDT(2026, 8, 4, 14, 36);
    assert.close(util.hoursBetween(a, b), 4 / 60, 1e-12, 'a 4-minute gap');
    assert.close(util.hoursBetween(util.mkDT(2026, 8, 1, 8, 0), util.mkDT(2026, 8, 6, 9, 0)), 121, 1e-12);
  });

  test('a spring-forward boundary does not change elapsed hours', function () {
    /* US DST began 2026-03-08. On the wall clock this is exactly 24 hours. */
    var before = util.mkDT(2026, 3, 7, 12, 0);
    var after = util.mkDT(2026, 3, 8, 12, 0);
    assert.close(util.hoursBetween(before, after), 24, 1e-12);
    assert.equal(util.midnightsCrossed(before, after), 1);
  });

  test('midnights come from calendar boundaries, not floor(hours/24)', function () {
    var admit = util.mkDT(2026, 8, 3, 23, 50);
    var discharge = util.mkDT(2026, 8, 4, 0, 10);
    assert.equal(util.midnightsCrossed(admit, discharge), 1, '20 minutes spanning midnight is 1 midnight');
    assert.close(util.hoursBetween(admit, discharge), 1 / 3, 1e-12);

    var long = util.mkDT(2026, 8, 3, 1, 0);
    var longEnd = util.mkDT(2026, 8, 3, 23, 0);
    assert.equal(util.midnightsCrossed(long, longEnd), 0, '22 hours inside one day is 0 midnights');
  });

  test('median and percentiles match the spreadsheet convention', function () {
    assert.equal(util.median([1, 2, 3]), 2);
    assert.equal(util.median([1, 2, 3, 4]), 2.5);
    assert.equal(util.percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.close(util.percentile([10, 20, 30, 40], 0.75), 32.5, 1e-9);
    assert.equal(util.percentile([], 0.5), null);
  });

  test('Excel serial round-trips a wall-clock datetime', function () {
    var dt = util.mkDT(2026, 8, 4, 14, 36);
    var back = util.fromExcelSerial(util.toExcelSerial(dt));
    assert.equal(back.getTime(), dt.getTime());
  });
});

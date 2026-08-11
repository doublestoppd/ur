/*
 * util.js - shared helpers: wall-clock datetime arithmetic, statistics, and
 * formatting.
 *
 * DATETIME MODEL (spec 9.1)
 * -------------------------
 * CPSI timestamps are hospital-local wall-clock values and must never be
 * timezone-converted. Every datetime in this application is therefore stored as
 * a JavaScript Date built from Date.UTC(...) and read back with the getUTC*
 * accessors. Using the UTC axis as a pure "wall clock" carrier means:
 *   - elapsed time is exactly the difference of the written clock values,
 *   - daylight-saving transitions on the workstation cannot shift a stay by an
 *     hour, and
 *   - the browser's local timezone has no effect on any calculated metric.
 * Never use new Date(y, m, d) or the local getFullYear()/getHours() accessors
 * on these values.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var MS_PER_HOUR = 3600000;
  var MS_PER_DAY = 86400000;

  var util = {
    MS_PER_HOUR: MS_PER_HOUR,
    MS_PER_DAY: MS_PER_DAY,

    /* ---------------------------------------------------------------- dates */

    /* Build a wall-clock datetime. month is 1-based. */
    mkDT: function (y, month, d, h, mi, s) {
      return new Date(Date.UTC(y, month - 1, d, h || 0, mi || 0, s || 0));
    },

    isDate: function (v) {
      return v instanceof Date && !isNaN(v.getTime());
    },

    /* Whole-day index on the wall clock. Used for midnight arithmetic. */
    dayIndex: function (dt) {
      return Math.floor(dt.getTime() / MS_PER_DAY);
    },

    /* Midnight at the start of dt's calendar day. */
    startOfDay: function (dt) {
      return new Date(Math.floor(dt.getTime() / MS_PER_DAY) * MS_PER_DAY);
    },

    addDays: function (dt, days) {
      return new Date(dt.getTime() + days * MS_PER_DAY);
    },

    /* Elapsed hours between two wall-clock datetimes (spec 9.1). */
    hoursBetween: function (start, end) {
      return (end.getTime() - start.getTime()) / MS_PER_HOUR;
    },

    /* Elapsed days = elapsed hours / 24, full precision retained (spec 9.1). */
    daysBetween: function (start, end) {
      return (end.getTime() - start.getTime()) / MS_PER_DAY;
    },

    /*
     * Number of local midnights crossed, derived from calendar boundaries
     * rather than floor(hours / 24) (spec 9.1). An admit on 08/03 23:50 with a
     * discharge on 08/04 00:10 crosses one midnight despite lasting 20 minutes.
     */
    midnightsCrossed: function (start, end) {
      return util.dayIndex(end) - util.dayIndex(start);
    },

    /* Overlap in hours between [aStart, aEnd) and [bStart, bEnd). */
    overlapHours: function (aStart, aEnd, bStart, bEnd) {
      var lo = Math.max(aStart.getTime(), bStart.getTime());
      var hi = Math.min(aEnd.getTime(), bEnd.getTime());
      return hi > lo ? (hi - lo) / MS_PER_HOUR : 0;
    },

    /* 0 = Sunday. Wall-clock day of week. */
    dayOfWeek: function (dt) {
      return dt.getUTCDay();
    },

    DAY_NAMES: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

    /* 'YYYY-MM' key for month-level trend grouping. */
    monthKey: function (dt) {
      return dt.getUTCFullYear() + '-' + util.pad2(dt.getUTCMonth() + 1);
    },

    monthLabel: function (key) {
      var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var parts = String(key).split('-');
      var m = parseInt(parts[1], 10);
      return (names[m - 1] || parts[1]) + ' ' + parts[0];
    },

    /* ----------------------------------------------------------- formatting */

    pad2: function (n) {
      return (n < 10 ? '0' : '') + n;
    },

    fmtDate: function (dt) {
      if (!util.isDate(dt)) { return ''; }
      return util.pad2(dt.getUTCMonth() + 1) + '/' + util.pad2(dt.getUTCDate()) + '/' + dt.getUTCFullYear();
    },

    fmtDateTime: function (dt) {
      if (!util.isDate(dt)) { return ''; }
      return util.fmtDate(dt) + ' ' + util.pad2(dt.getUTCHours()) + ':' + util.pad2(dt.getUTCMinutes());
    },

    fmtISODate: function (dt) {
      if (!util.isDate(dt)) { return ''; }
      return dt.getUTCFullYear() + '-' + util.pad2(dt.getUTCMonth() + 1) + '-' + util.pad2(dt.getUTCDate());
    },

    /*
     * Excel serial number for a wall-clock datetime, 1900 date system.
     * Written into the workbook alongside a number format so Excel renders a
     * real date cell without any timezone interpretation.
     */
    toExcelSerial: function (dt) {
      if (!util.isDate(dt)) { return null; }
      return dt.getTime() / MS_PER_DAY + 25569;
    },

    fromExcelSerial: function (serial) {
      return new Date(Math.round((serial - 25569) * MS_PER_DAY));
    },

    /* Round for display/export only; internals keep full precision. */
    round: function (v, places) {
      if (v === null || v === undefined || isNaN(v)) { return null; }
      var f = Math.pow(10, places === undefined ? 2 : places);
      return Math.round(v * f) / f;
    },

    /* ----------------------------------------------------------- statistics */

    sum: function (values) {
      var t = 0;
      for (var i = 0; i < values.length; i++) { t += values[i]; }
      return t;
    },

    mean: function (values) {
      if (!values.length) { return null; }
      return util.sum(values) / values.length;
    },

    /* Median using the average of the two middle values for even counts. */
    median: function (values) {
      if (!values.length) { return null; }
      var s = values.slice().sort(function (a, b) { return a - b; });
      var mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    },

    min: function (values) {
      return values.length ? Math.min.apply(null, values) : null;
    },

    max: function (values) {
      return values.length ? Math.max.apply(null, values) : null;
    },

    /*
     * Linear-interpolation percentile (the same method Excel's PERCENTILE.INC
     * uses), so exported percentiles reconcile with a spreadsheet recheck.
     */
    percentile: function (values, p) {
      if (!values.length) { return null; }
      var s = values.slice().sort(function (a, b) { return a - b; });
      if (s.length === 1) { return s[0]; }
      var rank = (s.length - 1) * p;
      var lo = Math.floor(rank);
      var hi = Math.ceil(rank);
      if (lo === hi) { return s[rank]; }
      return s[lo] + (s[hi] - s[lo]) * (rank - lo);
    },

    /* Percentage helper that returns null rather than NaN/Infinity. */
    pct: function (numerator, denominator) {
      if (!denominator) { return null; }
      return (numerator / denominator) * 100;
    },

    /* ------------------------------------------------------------- generics */

    /* Stable group-by returning { key: [items] } plus insertion-ordered keys. */
    groupBy: function (items, keyFn) {
      var map = {};
      var order = [];
      for (var i = 0; i < items.length; i++) {
        var k = keyFn(items[i], i);
        if (k === null || k === undefined) { k = ''; }
        k = String(k);
        if (!Object.prototype.hasOwnProperty.call(map, k)) {
          map[k] = [];
          order.push(k);
        }
        map[k].push(items[i]);
      }
      return { map: map, keys: order };
    },

    unique: function (values) {
      var seen = {};
      var out = [];
      for (var i = 0; i < values.length; i++) {
        var k = String(values[i]);
        if (!seen[k]) { seen[k] = true; out.push(values[i]); }
      }
      return out;
    },

    /* Deep clone of JSON-compatible configuration structures. */
    clone: function (obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    /* Case- and whitespace-insensitive key for code lookups. */
    codeKey: function (v) {
      if (v === null || v === undefined) { return ''; }
      return String(v).trim().toUpperCase();
    },

    contains: function (arr, v) {
      for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return true; } }
      return false;
    }
  };

  UR.util = util;

})(typeof globalThis !== 'undefined' ? globalThis : this);

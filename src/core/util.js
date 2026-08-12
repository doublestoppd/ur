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

    /* Case- and whitespace-insensitive key, for grouping and counting only. */
    codeKey: function (v) {
      if (v === null || v === undefined) { return ''; }
      return String(v).trim().toUpperCase();
    },

    /* The literal code as written, trimmed. Case is preserved. */
    codeExact: function (v) {
      if (v === null || v === undefined) { return ''; }
      return String(v).trim();
    },

    /*
     * Look one code up in a reference table.
     *
     * CODES ARE CASE-SENSITIVE. This hospital's insurance table contains 21
     * pairs that differ only in case and mean different payers - DCg is Humana
     * Women's Clinic while DCG is Lake Village Rehab - so an upper-cased lookup
     * would silently attribute an account to the wrong payer.
     *
     * Matching therefore runs in order of certainty and reports which rule fired:
     *   exact    - the code as written
     *   case     - a single row differing only in case (spreadsheets do mangle
     *              case, so this is accepted, but it is reported)
     *   numeric  - a single row equal as a number, so "6" finds "06" and back
     *              (Excel drops leading zeros from a numeric column)
     *   ambiguous- more than one row matched a fallback: nothing is chosen
     *
     * Returns { row, match, candidates }. `row` is null unless a single row won.
     */
    findByCode: function (rows, rawValue) {
      var value = util.codeExact(rawValue);
      var result = { row: null, match: null, candidates: [] };
      if (value === '' || !rows || !rows.length) { return result; }
      var i, row;

      for (i = 0; i < rows.length; i++) {
        if (util.codeExact(rows[i].code) === value) {
          result.row = rows[i];
          result.match = 'exact';
          return result;
        }
      }

      var upper = value.toUpperCase();
      var caseMatches = [];
      for (i = 0; i < rows.length; i++) {
        if (util.codeExact(rows[i].code).toUpperCase() === upper) { caseMatches.push(rows[i]); }
      }
      if (caseMatches.length === 1) {
        result.row = caseMatches[0];
        result.match = 'case';
        result.candidates = caseMatches;
        return result;
      }
      if (caseMatches.length > 1) {
        result.match = 'ambiguous';
        result.candidates = caseMatches;
        return result;
      }

      if (/^\d+$/.test(value)) {
        var asNumber = parseInt(value, 10);
        var numberMatches = [];
        for (i = 0; i < rows.length; i++) {
          var code = util.codeExact(rows[i].code);
          if (/^\d+$/.test(code) && parseInt(code, 10) === asNumber) { numberMatches.push(rows[i]); }
        }
        if (numberMatches.length === 1) {
          result.row = numberMatches[0];
          result.match = 'numeric';
          result.candidates = numberMatches;
          return result;
        }
        if (numberMatches.length > 1) {
          result.match = 'ambiguous';
          result.candidates = numberMatches;
          return result;
        }
      }

      return result;
    },

    /*
     * Attribute observed raw values to reference-table rows using the same
     * lookup the engine uses (findByCode), so a screen showing "rows in data"
     * beside each mapping can never disagree with what the engine actually did.
     *
     * Keying counts by upper-cased code - the previous behaviour - was wrong
     * twice over: case pairs like DCg/DCG pooled their counts onto both rows,
     * and a numeric origin column ("1" against table code "01") was reported as
     * unmapped even though the engine resolves it, inviting the user to add a
     * blank duplicate row that would then shadow the real mapping.
     *
     * valueCounts: { rawValue: occurrences }.
     * Returns { byCode, unmatched } where byCode is keyed by the EXACT code of
     * the row each value resolved to, and unmatched lists values no single row
     * matched - with `ambiguous: true` when several rows matched a fallback, a
     * case where adding a new row is precisely the wrong repair.
     */
    attributeCounts: function (rows, valueCounts) {
      var byCode = {};
      var unmatched = [];
      for (var value in valueCounts) {
        if (!Object.prototype.hasOwnProperty.call(valueCounts, value)) { continue; }
        var found = util.findByCode(rows, value);
        if (found.row) {
          var key = util.codeExact(found.row.code);
          byCode[key] = (byCode[key] || 0) + valueCounts[value];
        } else {
          unmatched.push({
            value: value,
            count: valueCounts[value],
            ambiguous: found.match === 'ambiguous'
          });
        }
      }
      unmatched.sort(function (a, b) {
        return b.count - a.count || (a.value < b.value ? -1 : 1);
      });
      return { byCode: byCode, unmatched: unmatched };
    },

    contains: function (arr, v) {
      for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return true; } }
      return false;
    }
  };

  UR.util = util;

})(typeof globalThis !== 'undefined' ? globalThis : this);

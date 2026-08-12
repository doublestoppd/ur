/*
 * parsers.js - tolerant parsing of the date, time, and code values that come
 * out of a CPSI Ad Hoc export.
 *
 * The same logical value arrives in several shapes depending on how the export
 * was produced: a true Excel date cell (numeric serial), a Date object handed
 * over by the spreadsheet reader, or free text. Times are frequently 4-digit
 * military values such as 1432, and sometimes 0 for midnight.
 *
 * Every parser returns { ok, value, reason } and never throws, so a single bad
 * cell becomes a diagnostic instead of a crash.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  function fail(reason) { return { ok: false, value: null, reason: reason }; }
  function ok(value) { return { ok: true, value: value, reason: '' }; }

  function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  /* Two-digit years: 70-99 map to the 1900s, 00-69 to the 2000s. */
  function expandYear(y) {
    if (y >= 100) { return y; }
    return y >= 70 ? 1900 + y : 2000 + y;
  }

  function validYMD(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) { return false; }
    var probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }

  var MONTH_NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  var parsers = {

    /*
     * Parse a date cell into a wall-clock datetime at 00:00 (any time component
     * present in the cell is returned separately in `timeFromDate`, so a single
     * combined "admit date/time" column still works).
     */
    parseDate: function (raw) {
      if (isBlank(raw)) { return fail('blank'); }

      /* A Date handed over by the reader. SheetJS builds these on the local
       * axis; read the local components back as wall-clock values. */
      if (raw instanceof Date) {
        if (isNaN(raw.getTime())) { return fail('invalid date value'); }
        var dt = util.mkDT(raw.getFullYear(), raw.getMonth() + 1, raw.getDate(), 0, 0);
        var frac = raw.getHours() * 60 + raw.getMinutes();
        return { ok: true, value: dt, reason: '', timeFromDate: frac > 0 ? frac : null };
      }

      /*
       * Compact YYYYMMDD is checked before the serial branch: an 8-digit value
       * is a plausible Excel serial numerically, but no realistic admission
       * date lands there, and CPSI exports do produce 20260803.
       */
      var compact = String(raw).trim().match(/^(19|20)(\d{2})(\d{2})(\d{2})$/);
      if (compact) {
        var cy = Number(compact[1] + compact[2]);
        var cm = Number(compact[3]);
        var cd = Number(compact[4]);
        if (validYMD(cy, cm, cd)) {
          return { ok: true, value: util.mkDT(cy, cm, cd, 0, 0), reason: '', timeFromDate: null };
        }
      }

      /* Numeric Excel serial. Values below 1 are a time-only cell. */
      if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()) && Number(raw) > 367)) {
        var serial = Number(raw);
        if (!isFinite(serial)) { return fail('non-numeric serial'); }
        if (serial < 1) { return fail('value looks like a time, not a date'); }
        if (serial > 2958465) { return fail('date serial out of range'); }
        var whole = Math.floor(serial);
        var d0 = util.fromExcelSerial(whole);
        var minutes = Math.round((serial - whole) * 1440);
        return { ok: true, value: d0, reason: '', timeFromDate: minutes > 0 ? minutes : null };
      }

      var text = String(raw).trim();
      if (!text) { return fail('blank'); }

      /* Split off a trailing time component if the cell holds both. */
      var timeMinutes = null;
      var combined = text.match(/^(.*?)[\sT]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)$/);
      if (combined) {
        text = combined[1].trim();
        var tRes = parsers.parseTime(combined[2]);
        if (tRes.ok) { timeMinutes = tRes.value; }
      }

      var y, m, d, mm;

      /* ISO: YYYY-MM-DD or YYYY/MM/DD */
      mm = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
      if (mm) {
        y = +mm[1]; m = +mm[2]; d = +mm[3];
        if (!validYMD(y, m, d)) { return fail('impossible date "' + text + '"'); }
        return { ok: true, value: util.mkDT(y, m, d, 0, 0), reason: '', timeFromDate: timeMinutes };
      }

      /* US: MM/DD/YYYY, M-D-YY, MM.DD.YYYY */
      mm = text.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
      if (mm) {
        m = +mm[1]; d = +mm[2]; y = expandYear(+mm[3]);
        if (!validYMD(y, m, d)) { return fail('impossible date "' + text + '"'); }
        return { ok: true, value: util.mkDT(y, m, d, 0, 0), reason: '', timeFromDate: timeMinutes };
      }

      /* Month name: 03 Aug 2026 / Aug 3, 2026 */
      mm = text.match(/^(\d{1,2})[\s-]*([A-Za-z]{3,})[\s-]*(\d{2,4})$/);
      if (mm && MONTH_NAMES[mm[2].slice(0, 3).toLowerCase()]) {
        d = +mm[1]; m = MONTH_NAMES[mm[2].slice(0, 3).toLowerCase()]; y = expandYear(+mm[3]);
        if (!validYMD(y, m, d)) { return fail('impossible date "' + text + '"'); }
        return { ok: true, value: util.mkDT(y, m, d, 0, 0), reason: '', timeFromDate: timeMinutes };
      }
      mm = text.match(/^([A-Za-z]{3,})[\s-]*(\d{1,2}),?[\s-]*(\d{2,4})$/);
      if (mm && MONTH_NAMES[mm[1].slice(0, 3).toLowerCase()]) {
        m = MONTH_NAMES[mm[1].slice(0, 3).toLowerCase()]; d = +mm[2]; y = expandYear(+mm[3]);
        if (!validYMD(y, m, d)) { return fail('impossible date "' + text + '"'); }
        return { ok: true, value: util.mkDT(y, m, d, 0, 0), reason: '', timeFromDate: timeMinutes };
      }

      /* Compact YYYYMMDD */
      mm = text.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (mm) {
        y = +mm[1]; m = +mm[2]; d = +mm[3];
        if (!validYMD(y, m, d)) { return fail('impossible date "' + text + '"'); }
        return { ok: true, value: util.mkDT(y, m, d, 0, 0), reason: '', timeFromDate: timeMinutes };
      }

      return fail('unrecognized date format "' + String(raw).trim() + '"');
    },

    /*
     * Parse a time cell into minutes past midnight (0-1439).
     * Accepts 14:32, 2:32 PM, 1432, 832, 0, 14:32:07, and Excel time fractions.
     */
    parseTime: function (raw) {
      if (raw === null || raw === undefined) { return fail('blank'); }
      if (typeof raw === 'string' && raw.trim() === '') { return fail('blank'); }

      if (raw instanceof Date) {
        if (isNaN(raw.getTime())) { return fail('invalid time value'); }
        return ok(raw.getHours() * 60 + raw.getMinutes());
      }

      var text = String(raw).trim();

      /* Excel time fraction, e.g. 0.605555 = 14:32. A fraction within half a
       * minute of 1.0 rounds to 1440; wrapping that to 0 - the old behaviour -
       * would turn a 23:59:59.6 discharge into midnight the SAME day, moving
       * the timestamp back a full day. Clamp to 23:59 instead, losing at most
       * one minute. */
      if (/^0?\.\d+$/.test(text)) {
        var frac = Number(text);
        var fracMinutes = Math.round(frac * 1440);
        return ok(fracMinutes >= 1440 ? 1439 : fracMinutes);
      }

      /* HH:MM[:SS] with optional meridiem. */
      var mm = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]?)?$/);
      if (mm) {
        var h = +mm[1];
        var mi = +mm[2];
        var mer = mm[4] ? mm[4].charAt(0).toLowerCase() : null;
        if (mer) {
          if (h < 1 || h > 12) { return fail('hour out of range in "' + text + '"'); }
          if (mer === 'p' && h !== 12) { h += 12; }
          if (mer === 'a' && h === 12) { h = 0; }
        }
        if (h > 23 || mi > 59) { return fail('time out of range "' + text + '"'); }
        return ok(h * 60 + mi);
      }

      /* Military/compact digits: 0, 7, 832, 1432, 002359 -> ignore seconds. */
      if (/^\d{1,6}$/.test(text)) {
        var digits = text;
        if (digits.length === 6) { digits = digits.slice(0, 4); }
        if (digits.length === 5) { digits = ('0' + digits).slice(0, 4); }
        var n = parseInt(digits, 10);
        var hh, mmn;
        if (digits.length <= 2) {
          /* A bare 0-23 is an hour; anything larger is not a usable time. */
          if (n > 23) { return fail('ambiguous compact time "' + text + '"'); }
          hh = n; mmn = 0;
        } else {
          hh = Math.floor(n / 100);
          mmn = n % 100;
        }
        if (hh === 24 && mmn === 0) { return ok(0); }
        if (hh > 23 || mmn > 59) { return fail('time out of range "' + text + '"'); }
        return ok(hh * 60 + mmn);
      }

      return fail('unrecognized time format "' + text + '"');
    },

    /* Combine a parsed date with minutes past midnight into a wall-clock datetime. */
    combine: function (dateValue, minutes) {
      if (!util.isDate(dateValue)) { return null; }
      return new Date(dateValue.getTime() + (minutes || 0) * 60000);
    },

    /* Trimmed string value; blanks become ''. */
    parseText: function (raw) {
      if (raw === null || raw === undefined) { return ''; }
      if (raw instanceof Date) { return util.fmtDateTime(raw); }
      return String(raw).trim();
    },

    /*
     * Identifier normalization for account numbers and similar ids. Numeric cells come
     * back as numbers and would otherwise fail to match their text twins;
     * trailing ".0" from float coercion is removed.
     */
    parseId: function (raw) {
      if (raw === null || raw === undefined) { return ''; }
      if (typeof raw === 'number') {
        return Number.isInteger(raw) ? String(raw) : String(raw);
      }
      var s = String(raw).trim();
      if (/^\d+\.0+$/.test(s)) { s = s.replace(/\.0+$/, ''); }
      return s;
    }
  };

  UR.parsers = parsers;

})(typeof globalThis !== 'undefined' ? globalThis : this);

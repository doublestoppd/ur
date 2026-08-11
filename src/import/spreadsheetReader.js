/*
 * spreadsheetReader.js - reads CPSI Ad Hoc exports (.xlsx / .xls / .csv) into
 * plain header + row tables (spec 4.2, 6.3).
 *
 * The bundled SheetJS build (vendor/xlsx.full.min.js, Apache-2.0) is the only
 * third-party dependency and is loaded from disk, never from a CDN.
 *
 * Cells are read raw: dates stay as Excel serial numbers and times stay as
 * whatever the export produced, so parsers.js can apply the hospital wall-clock
 * rules instead of inheriting the browser timezone.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  function xlsx() {
    var X = global.XLSX;
    if (!X) {
      throw new Error('The bundled spreadsheet library did not load. Confirm that vendor/xlsx.full.min.js sits beside index.html.');
    }
    return X;
  }

  /* A row is empty when every cell is null, undefined, or blank text. */
  function isEmptyRow(row) {
    if (!row) { return true; }
    for (var i = 0; i < row.length; i++) {
      var v = row[i];
      if (v === null || v === undefined) { continue; }
      if (typeof v === 'string' && v.trim() === '') { continue; }
      return false;
    }
    return true;
  }

  function countFilled(row) {
    var n = 0;
    for (var i = 0; i < row.length; i++) {
      var v = row[i];
      if (v === null || v === undefined) { continue; }
      if (typeof v === 'string' && v.trim() === '') { continue; }
      n++;
    }
    return n;
  }

  var spreadsheetReader = {

    /*
     * Locate the header row. CPSI exports sometimes carry a title line or a
     * blank line above the real headers, so the first row with at least two
     * filled cells that is followed by a comparably wide row wins. Falls back to
     * the first non-empty row.
     */
    findHeaderRow: function (matrix) {
      var firstNonEmpty = -1;
      for (var r = 0; r < matrix.length && r < 25; r++) {
        if (isEmptyRow(matrix[r])) { continue; }
        if (firstNonEmpty < 0) { firstNonEmpty = r; }
        var filled = countFilled(matrix[r]);
        if (filled < 2) { continue; }
        var next = matrix[r + 1];
        if (next && !isEmptyRow(next) && countFilled(next) >= Math.min(2, filled - 1)) {
          return r;
        }
      }
      return firstNonEmpty < 0 ? 0 : firstNonEmpty;
    },

    /* Convert a worksheet into { headers, rows, headerRowIndex }. */
    sheetToTable: function (worksheet) {
      var X = xlsx();
      var matrix = X.utils.sheet_to_json(worksheet, {
        header: 1,
        raw: true,       /* keep Excel serials; parsers.js owns interpretation */
        defval: null,
        blankrows: false
      });
      return spreadsheetReader.matrixToTable(matrix);
    },

    /* Same conversion for an already-materialized array of arrays (used by tests). */
    matrixToTable: function (matrix) {
      if (!matrix || !matrix.length) { return { headers: [], rows: [], headerRowIndex: 0 }; }
      var hIndex = spreadsheetReader.findHeaderRow(matrix);
      var rawHeaders = matrix[hIndex] || [];
      var headers = [];
      for (var c = 0; c < rawHeaders.length; c++) {
        var v = rawHeaders[c];
        headers.push(v === null || v === undefined ? '' : String(v).trim());
      }
      /* Trim trailing unnamed columns. */
      while (headers.length && headers[headers.length - 1] === '') { headers.pop(); }

      var rows = [];
      for (var r = hIndex + 1; r < matrix.length; r++) {
        if (isEmptyRow(matrix[r])) { continue; }
        rows.push({ cells: matrix[r], sourceRowNumber: r + 1 });
      }
      return { headers: headers, rows: rows, headerRowIndex: hIndex };
    },

    /*
     * Read one file's bytes into { fileName, sheets: [{ name, headers, rows }] }.
     * `data` is an ArrayBuffer or Uint8Array from FileReader.
     */
    readFile: function (fileName, data) {
      var X = xlsx();
      var wb;
      try {
        wb = X.read(data, { type: 'array', cellDates: false, raw: true });
      } catch (e) {
        return {
          fileName: fileName,
          error: 'The file could not be read as a spreadsheet or CSV (' + (e && e.message ? e.message : 'unknown error') + ').',
          sheets: []
        };
      }
      var sheets = [];
      for (var i = 0; i < wb.SheetNames.length; i++) {
        var name = wb.SheetNames[i];
        var table = spreadsheetReader.sheetToTable(wb.Sheets[name]);
        sheets.push({
          name: name,
          headers: table.headers,
          rows: table.rows,
          headerRowIndex: table.headerRowIndex,
          rowCount: table.rows.length
        });
      }
      return { fileName: fileName, error: null, sheets: sheets };
    },

    /*
     * Pick the sheet most likely to hold the encounter export: the one with the
     * most data rows that also exposes at least one recognizable canonical
     * header. Sheets are never merged blindly.
     */
    pickDataSheet: function (sheets) {
      var best = null;
      for (var i = 0; i < sheets.length; i++) {
        var s = sheets[i];
        if (!s.rowCount) { continue; }
        var auto = UR.headerMapper.autoMap(s.headers);
        var mapped = 0;
        for (var k in auto.mapping) {
          if (Object.prototype.hasOwnProperty.call(auto.mapping, k) && auto.mapping[k]) { mapped++; }
        }
        var candidate = { sheet: s, mappedCount: mapped };
        if (!best ||
            candidate.mappedCount > best.mappedCount ||
            (candidate.mappedCount === best.mappedCount && s.rowCount > best.sheet.rowCount)) {
          best = candidate;
        }
      }
      return best ? best.sheet : (sheets.length ? sheets[0] : null);
    },

    /* Cell value for a canonical field, given a validated mapping. */
    cellFor: function (row, mapping, fieldKey) {
      var m = mapping[fieldKey];
      if (!m) { return null; }
      var v = row.cells[m.index];
      return v === undefined ? null : v;
    }
  };

  UR.spreadsheetReader = spreadsheetReader;

})(typeof globalThis !== 'undefined' ? globalThis : this);

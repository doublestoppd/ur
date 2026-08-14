/*
 * serviceLogParser.js - parse the CPSI "Service Log for Service CD" report
 * (CNSERVLOG), the PDF that documents in-place service changes such as an
 * account converting from observation to inpatient.
 *
 * Layout (line-printer style, one change per row):
 *
 *   RUN DATE: 08/14/26        <FACILITY>                        PAGE 1
 *       TIME: 08:45   SERVICE LOG FOR SERVICE CD   06/01/26-06/30/26  CNSERVLOG
 *                     CHANGED FROM: OS
 *   -------------------CHANGED-TO:---IP ...
 *     PAT NUM   PAT NAME       FROM    TO      DATE   TIME   INITIALS
 *     80180009  NAME           OS      IP    6/06/26  13:10     ABC
 *
 * The DATE/TIME is the moment of the status change - for an OS -> IP row that
 * is the observation discharge and the true inpatient admission.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var parsers = UR.parsers;

  var ROW = /^\s*(\d{5,})\s+(.*?)\s+([A-Z]{1,4})\s+([A-Z]{1,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2})(?:\s+(\S+))?\s*$/;

  UR.serviceLogParser = {

    /* True when the lines look like a CNSERVLOG report. */
    matches: function (lines) {
      return lines.some(function (l) { return l.indexOf('SERVICE LOG FOR SERVICE CD') >= 0; }) ||
             lines.some(function (l) { return l.indexOf('CNSERVLOG') >= 0; });
    },

    /*
     * lines -> { ok, reportRange, facility, rows: [{ account, name, from, to,
     * changeDT, initials }], unparsed } . Rows whose service pair is not a
     * change this tool models are still returned; the caller decides.
     */
    parse: function (lines) {
      var out = { ok: false, facility: '', reportRange: '', rows: [], unparsed: [] };
      if (!UR.serviceLogParser.matches(lines)) { return out; }
      out.ok = true;

      lines.forEach(function (line) {
        var header = /SERVICE LOG FOR SERVICE CD\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(line);
        if (header) { out.reportRange = header[1] + ' - ' + header[2]; }
        var run = /RUN DATE:\s*\S+\s+(.*?)\s+PAGE/.exec(line);
        if (run) { out.facility = run[1].trim(); }

        if (/PAT NUM|CHANGED|RUN DATE|TIME:|^-+|SERVICE LOG/.test(line)) { return; }
        var m = ROW.exec(line);
        if (!m) {
          if (line.replace(/\s+/g, '') !== '') { out.unparsed.push(line); }
          return;
        }
        var dateRes = parsers.parseDate(m[5]);
        var timeRes = parsers.parseTime(m[6]);
        var changeDT = (dateRes.ok && timeRes.ok) ? parsers.combine(dateRes.value, timeRes.value) : null;
        out.rows.push({
          account: m[1],
          name: m[2].replace(/\s+/g, ' ').trim(),
          from: m[3],
          to: m[4],
          changeDT: changeDT,
          rawDate: m[5],
          rawTime: m[6],
          initials: m[7] || ''
        });
      });

      /*
       * A PDF that draws the page in more than one content stream (edited or
       * annotated files) can repeat the same change; the same account, pair,
       * and moment is one change however many times it is drawn. The first
       * occurrence keeps the fullest text.
       */
      var seen = {};
      out.rows = out.rows.filter(function (r) {
        var key = r.account + '|' + r.from + '|' + r.to + '|' + (r.changeDT ? r.changeDT.getTime() : r.rawDate + r.rawTime);
        if (seen[key]) { return false; }
        seen[key] = true;
        return true;
      });
      return out;
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

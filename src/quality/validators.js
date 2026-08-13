/*
 * validators.js - structural validation (spec 11.1, 11.2).
 *
 * Blocking checks run before and immediately after normalization and stop the
 * run outright. Everything softer is raised as an Error, Warning, or Info by
 * the module that discovered it.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  var validators = {

    /* Pre-flight: is there anything to process at all? */
    validateSources: function (sources, diag) {
      var totalRows = 0;
      for (var i = 0; i < sources.length; i++) { totalRows += sources[i].rows.length; }
      if (!totalRows) {
        diag.add('DQ_NO_ROWS', {
          message: 'The selected files and worksheets contain no data rows below the header row.'
        });
        return false;
      }
      return true;
    },

    /*
     * Per-file mapping check. Every imported table must be able to supply the
     * required and strongly-recommended fields; a file that cannot is named,
     * with the count of rows affected, rather than quietly contributing rows
     * that fall out of every metric.
     */
    reportSourceMappings: function (sources, diag) {
      var reported = 0;
      var guarded = 0;
      for (var g = 0; g < sources.length; g++) { guarded += sources[g].excelGuardCells || 0; }
      if (guarded) {
        diag.add('DQ_EXCEL_GUARD', {
          message: guarded + ' cell(s) arrived wrapped in an Excel text-guard formula (e.g. ="04"). ' +
                   'The wrapper was stripped and the underlying value used, so these cells match the code tables normally. ' +
                   'No action is needed; rows added to a code table with the wrapper still in the code (="04") can be removed.'
        });
      }
      for (var s = 0; s < sources.length; s++) {
        var source = sources[s];
        var missing = [];
        var fields = UR.headerMapper.FIELDS;
        for (var f = 0; f < fields.length; f++) {
          var field = fields[f];
          if (field.requirement !== 'required' && field.requirement !== 'strong') { continue; }
          if (source.mapping && source.mapping[field.key]) { continue; }
          missing.push(field.label);
        }
        if (!missing.length) { continue; }
        reported++;
        diag.add('DQ_MAP_REQUIRED', {
          severity: UR.SEVERITY.WARNING,
          sourceFile: source.fileName,
          sourceSheet: source.sheetName,
          message: source.fileName + ' (' + source.sheetName + ') has no column mapped for: ' + missing.join(', ') +
                   '. Its ' + source.rows.length + ' row(s) are affected. Check that this file has the same layout as the others.'
        });
      }
      return reported;
    },

    /* Post-normalization: did the mapped columns actually contain usable data? */
    validateNormalized: function (encounters, diag) {
      var ok = true;
      var i, e;

      var anyIncluded = 0;
      var anyRecognizedService = 0;
      var anyAdmit = 0;
      for (i = 0; i < encounters.length; i++) {
        e = encounters[i];
        if (e.serviceClass !== UR.SERVICE.UNKNOWN) { anyRecognizedService++; }
        if (e.included) { anyIncluded++; }
        if (e.admitDT) { anyAdmit++; }
      }

      if (!anyRecognizedService) {
        diag.add('DQ_SERVICE_COLUMN', {
          message: 'No row carried a service code present in the service-code reference table. Either the wrong column is mapped to Service code, or the reference table needs this hospital\'s codes added.'
        });
        ok = false;
      } else if (!anyIncluded) {
        diag.add('DQ_SERVICE_COLUMN', {
          message: 'Service codes were recognized, but none map to an included behavior (IP, OS, or SB). Nothing would be calculated. Check the service-code reference table.'
        });
        ok = false;
      }

      if (!anyAdmit) {
        diag.add('DQ_DATE_COLUMN', {
          message: 'No admission date could be parsed on any row. Confirm the Admission date mapping and the export\'s date format.'
        });
        ok = false;
      }

      return ok;
    },

    /*
     * Records outside the reporting period are retained for episode, transition,
     * and readmission context but excluded from period counts. Reported once as
     * a single Info line rather than one per row.
     */
    reportOutOfPeriod: function (encounters, period, diag) {
      var whollyOutside = 0;
      var partial = 0;
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible || !e.admitDT) { continue; }
        if (!UR.scope.overlapsPeriod(e, period)) { whollyOutside++; }
        else if (!UR.scope.inPeriod(e.admitDT, period)) { partial++; }
      }
      if (whollyOutside) {
        diag.add('DQ_OUT_OF_PERIOD', {
          message: whollyOutside + ' included record(s) lie wholly outside ' + period.label +
                   '. They remain available for episode, transition, and readmission context but contribute to no period figure.'
        });
      }
      if (partial) {
        diag.add('DQ_OUT_OF_PERIOD', {
          message: partial + ' included record(s) were admitted before ' + period.label +
                   ' but their stay reaches into it. They COUNT in discharged-stay, occupancy, patient, review, and transition figures; ' +
                   'only the admission event itself falls outside the period, so admission counts exclude it.'
        });
      }
      return whollyOutside + partial;
    },

    /* Roll-up used by the processing summary panel (spec 11.3). */
    summarize: function (state) {
      var counts = { imported: 0, ip: 0, os: 0, sb: 0, ignored: 0, unknown: 0, excludedOther: 0, open: 0 };
      var encounters = state.encounters;
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        counts.imported++;
        if (e.serviceClass === UR.SERVICE.IP) { counts.ip++; }
        else if (e.serviceClass === UR.SERVICE.OS) { counts.os++; }
        else if (e.serviceClass === UR.SERVICE.SB) { counts.sb++; }
        else if (e.serviceClass === UR.SERVICE.IGNORED) { counts.ignored++; }
        else { counts.unknown++; }
        if (e.included && !e.metricEligible) { counts.excludedOther++; }
        if (e.isOpen) { counts.open++; }
      }
      counts.excludedByPolicy = counts.ignored + counts.unknown;
      return counts;
    },

    /* Human-readable processing summary lines (spec 11.3). */
    summaryLines: function (state) {
      var c = validators.summarize(state);
      var d = state.diagnostics.counts();
      var lines = [];
      lines.push(c.imported + ' rows imported');
      lines.push(c.ip + ' IP | ' + c.os + ' OS | ' + c.sb + ' SB');
      lines.push(c.excludedByPolicy + ' rows excluded by service-code policy (' + c.ignored + ' ignored, ' + c.unknown + ' unrecognized)');
      if (c.excludedOther) { lines.push(c.excludedOther + ' included rows excluded because of data errors'); }
      if (c.open) { lines.push(c.open + ' open encounter(s)'); }
      var t = state.transitionCounts || {};
      lines.push((t.osip || 0) + ' OS->IP | ' + (t.ipsb || 0) + ' IP->SB | ' + (t.sbip || 0) + ' SB->IP transitions');
      lines.push((state.episodes ? state.episodes.length : 0) + ' continuous episodes');
      if (state.readmissions) {
        var windows = state.config.thresholds.readmissionWindowDays;
        var longest = windows[windows.length - 1];
        lines.push(UR.readmissionDetector.within(state.readmissions.pairs, longest).length +
                   ' potential ' + longest + '-day readmissions');
      }
      lines.push(d.Blocking + ' blocking | ' + d.Error + ' errors | ' + d.Warning + ' warnings | ' + d.Info + ' informational notices');
      return lines;
    }
  };

  UR.validators = validators;

})(typeof globalThis !== 'undefined' ? globalThis : this);

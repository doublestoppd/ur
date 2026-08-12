/*
 * codeInventory.js - the "no silent unknowns" inventory (spec 7.2, 11.4).
 *
 * Every distinct service, discharge, insurance, and admission-source value that
 * appeared in the input is listed with its count, its configured meaning, the
 * behavior applied, and a status of recognized/used, recognized/ignored, or
 * unrecognized. The user sees this before exporting.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var cfgSchema = UR.configSchema;

  var STATUS = {
    USED: 'Recognized / used',
    IGNORED: 'Recognized / ignored',
    UNRECOGNIZED: 'Unrecognized'
  };

  function tally(encounters, valueFn, sampleLimit) {
    var limit = sampleLimit || 5;
    var map = {};
    var order = [];
    for (var i = 0; i < encounters.length; i++) {
      var e = encounters[i];
      var v = valueFn(e);
      if (v === null || v === undefined) { continue; }
      var key = v === '' ? '(blank)' : String(v);
      if (!map[key]) {
        map[key] = { value: key, rawValue: v, count: 0, samples: [] };
        order.push(key);
      }
      map[key].count++;
      if (map[key].samples.length < limit) { map[key].samples.push(e.account); }
    }
    var rows = [];
    for (var k = 0; k < order.length; k++) { rows.push(map[order[k]]); }
    rows.sort(function (a, b) { return b.count - a.count || (a.value < b.value ? -1 : 1); });
    return rows;
  }

  var codeInventory = {
    STATUS: STATUS,

    build: function (encounters, config, mapping) {
      var sections = [];
      var i, row;

      /* ------------------------------------------------------ service codes */
      var serviceRows = tally(encounters, function (e) { return e.serviceRaw; });
      for (i = 0; i < serviceRows.length; i++) {
        row = serviceRows[i];
        var svc = cfgSchema.serviceBehavior(config, row.rawValue);
        row.mappedTo = svc.row ? (svc.row.label || svc.row.behavior) : '';
        row.behavior = svc.behavior === UR.SERVICE.UNKNOWN ? 'Excluded (not in reference table)'
          : (svc.behavior === UR.SERVICE.IGNORED ? 'Excluded by policy' : 'Included as ' + svc.behavior);
        row.status = svc.behavior === UR.SERVICE.UNKNOWN ? STATUS.UNRECOGNIZED
          : (svc.behavior === UR.SERVICE.IGNORED ? STATUS.IGNORED : STATUS.USED);
      }
      sections.push({ type: 'Service code', field: 'service', mapped: !!mapping.service, rows: serviceRows });

      /* ---------------------------------------------------- discharge codes */
      var disRows = tally(encounters, function (e) { return e.dischargeCodeRaw; });
      for (i = 0; i < disRows.length; i++) {
        row = disRows[i];
        if (row.value === '(blank)') {
          row.mappedTo = '';
          row.behavior = 'No discharge code supplied';
          row.status = STATUS.UNRECOGNIZED;
          continue;
        }
        var dc = cfgSchema.dischargeCode(config, row.rawValue);
        row.mappedTo = dc ? dc.label : '';
        /* A disabled row is described as the engine treats it, not as it would
         * behave if enabled - the inventory must never disagree with the run. */
        row.behavior = !dc ? 'Disposition unknown; no transition assumed'
          : (dc.enabled === false
            ? 'Disabled in the reference table; treated as unrecognized (no disposition, no transition)'
            : (dc.transitionTo ? 'Internal transition -> ' + dc.transitionTo : 'Disposition: ' + (dc.category || 'Other')));
        row.status = dc ? (dc.enabled === false ? STATUS.IGNORED : STATUS.USED) : STATUS.UNRECOGNIZED;
      }
      sections.push({ type: 'Discharge code', field: 'dischargeCode', mapped: !!mapping.dischargeCode, rows: disRows });

      /* ---------------------------------------------------- insurance codes */
      var insRows = tally(encounters, function (e) { return e.insuranceRaw; });
      for (i = 0; i < insRows.length; i++) {
        row = insRows[i];
        var ins = row.value === '(blank)' ? null : cfgSchema.insuranceCode(config, row.rawValue);
        row.mappedTo = ins ? (ins.label || '') : '';
        row.behavior = !ins || !ins.category ? 'Payer category: Unknown'
          : (ins.enabled === false
            ? 'Retired code - accounts group under Unknown (stored category: ' + ins.category + ')'
            : 'Payer category: ' + ins.category);
        row.status = ins && ins.category ? (ins.enabled === false ? STATUS.IGNORED : STATUS.USED) : STATUS.UNRECOGNIZED;
      }
      sections.push({ type: 'Insurance code', field: 'insurance', mapped: !!mapping.insurance, rows: insRows });

      /* ------------------------------------------------- admission sources */
      var srcRows = tally(encounters, function (e) { return e.admissionSourceRaw; });
      for (i = 0; i < srcRows.length; i++) {
        row = srcRows[i];
        var src = row.value === '(blank)' ? null : cfgSchema.admissionSource(config, row.rawValue);
        row.mappedTo = src ? (src.label || '') : '';
        row.behavior = !src ? 'Unmapped'
          : (src.enabled === false
            ? 'Disabled in the reference table; reports as Unknown'
            : (src.category ? 'Category: ' + src.category : 'Mapped, no category'));
        row.status = src ? (src.enabled === false ? STATUS.IGNORED : STATUS.USED) : STATUS.UNRECOGNIZED;
      }
      sections.push({ type: 'Admission source', field: 'admissionSource', mapped: !!mapping.admissionSource, rows: srcRows });

      return sections;
    },

    /* Distinct unrecognized values across all sections. */
    unrecognized: function (sections) {
      var out = [];
      for (var s = 0; s < sections.length; s++) {
        for (var r = 0; r < sections[s].rows.length; r++) {
          if (sections[s].rows[r].status === STATUS.UNRECOGNIZED) {
            out.push({ type: sections[s].type, value: sections[s].rows[r].value, count: sections[s].rows[r].count });
          }
        }
      }
      return out;
    },

    /* Rows the user could add to the reference tables in one click. */
    suggestedMappings: function (sections) {
      var out = { insuranceCodes: [], admissionSources: [], serviceCodes: [], dischargeCodes: [] };
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        for (var r = 0; r < sec.rows.length; r++) {
          var row = sec.rows[r];
          if (row.status !== STATUS.UNRECOGNIZED || row.value === '(blank)') { continue; }
          if (sec.field === 'insurance') { out.insuranceCodes.push(UR.defaultMappings.blankInsurance(row.value)); }
          if (sec.field === 'admissionSource') { out.admissionSources.push(UR.defaultMappings.blankAdmissionSource(row.value)); }
          if (sec.field === 'service') { out.serviceCodes.push({ code: row.value, label: '', behavior: UR.SERVICE.IGNORED, enabled: true }); }
          if (sec.field === 'dischargeCode') { out.dischargeCodes.push({ code: row.value, label: '', category: 'Other', transitionTo: null, enabled: true }); }
        }
      }
      return out;
    }
  };

  UR.codeInventory = codeInventory;

})(typeof globalThis !== 'undefined' ? globalThis : this);

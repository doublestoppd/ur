/*
 * diagnostics.js - the diagnostic collector shared by every processing stage
 * (spec 11).
 *
 * One collector accumulates findings for a whole run. Each finding names the
 * data-quality rule that produced it, so severity and wording come from the
 * registry rather than from scattered string literals.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  function create() {
    var items = [];
    var seq = 0;

    var api = {
      /*
       * ruleId  - id from UR.dataQualityRules
       * detail  - { message, account, mrn, service, rowRef, sourceFile,
       *             sourceSheet, sourceRow, value, severity }
       * `severity` overrides the registry default only when a specific
       * occurrence is genuinely more or less serious.
       */
      add: function (ruleId, detail) {
        var rule = UR.dataQualityRules.byId(ruleId);
        var d = detail || {};
        var item = {
          seq: seq++,
          rowId: d.rowId === undefined ? null : d.rowId,
          ruleId: ruleId,
          severity: d.severity || (rule ? rule.severity : UR.SEVERITY.WARNING),
          name: rule ? rule.name : ruleId,
          message: d.message || (rule ? rule.description : ''),
          effect: rule ? rule.effect : '',
          account: d.account === undefined ? '' : d.account,
          mrn: d.mrn === undefined ? '' : d.mrn,
          service: d.service === undefined ? '' : d.service,
          value: d.value === undefined ? '' : d.value,
          sourceFile: d.sourceFile || '',
          sourceSheet: d.sourceSheet || '',
          sourceRow: d.sourceRow === undefined ? '' : d.sourceRow
        };
        items.push(item);
        return item;
      },

      /* Attach a finding to an encounter and record it on the encounter too. */
      addFor: function (ruleId, encounter, detail) {
        var d = detail || {};
        d.rowId = d.rowId !== undefined ? d.rowId : encounter.rowId;
        d.account = d.account !== undefined ? d.account : encounter.account;
        d.mrn = d.mrn !== undefined ? d.mrn : encounter.mrn;
        d.service = d.service !== undefined ? d.service : encounter.serviceRaw;
        d.sourceFile = d.sourceFile || encounter.sourceFile;
        d.sourceSheet = d.sourceSheet || encounter.sourceSheet;
        d.sourceRow = d.sourceRow !== undefined ? d.sourceRow : encounter.sourceRowNumber;
        var item = api.add(ruleId, d);
        if (!encounter.flags) { encounter.flags = []; }
        encounter.flags.push(item);
        return item;
      },

      /*
       * Discard every finding raised against one source row. Used when a row is
       * collapsed as an exact duplicate: its findings would otherwise be
       * counted twice and no longer correspond to any retained record. The
       * removal itself is always reported separately (DQ_ROW_DEDUP).
       */
      dropRow: function (rowId) {
        var kept = [];
        var removed = 0;
        for (var i = 0; i < items.length; i++) {
          if (items[i].rowId !== null && items[i].rowId === rowId) { removed++; continue; }
          kept.push(items[i]);
        }
        items = kept;
        return removed;
      },

      all: function () { return items.slice(); },

      /* Findings ordered by severity, then by rule, then by discovery order. */
      sorted: function () {
        var order = UR.SEVERITY_ORDER;
        return items.slice().sort(function (a, b) {
          var sa = order.indexOf(a.severity);
          var sb = order.indexOf(b.severity);
          if (sa !== sb) { return sa - sb; }
          if (a.ruleId !== b.ruleId) { return a.ruleId < b.ruleId ? -1 : 1; }
          return a.seq - b.seq;
        });
      },

      counts: function () {
        var c = { Blocking: 0, Error: 0, Warning: 0, Info: 0 };
        for (var i = 0; i < items.length; i++) {
          if (c[items[i].severity] === undefined) { c[items[i].severity] = 0; }
          c[items[i].severity]++;
        }
        return c;
      },

      /* Rolled-up view: one row per rule with an occurrence count and samples. */
      byRule: function (sampleLimit) {
        var limit = sampleLimit || 5;
        var map = {};
        var order = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (!map[it.ruleId]) {
            map[it.ruleId] = {
              ruleId: it.ruleId, name: it.name, severity: it.severity,
              count: 0, samples: [], messages: []
            };
            order.push(it.ruleId);
          }
          var g = map[it.ruleId];
          g.count++;
          if (g.samples.length < limit && it.account) { g.samples.push(it.account); }
          if (g.messages.length < limit && it.message && g.messages.indexOf(it.message) < 0) {
            g.messages.push(it.message);
          }
        }
        var out = [];
        for (var k = 0; k < order.length; k++) { out.push(map[order[k]]); }
        var sev = UR.SEVERITY_ORDER;
        out.sort(function (a, b) {
          var sa = sev.indexOf(a.severity), sb = sev.indexOf(b.severity);
          return sa !== sb ? sa - sb : (a.ruleId < b.ruleId ? -1 : 1);
        });
        return out;
      },

      forAccount: function (account) {
        var out = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].account === account) { out.push(items[i]); }
        }
        return out;
      },

      hasBlocking: function () {
        for (var i = 0; i < items.length; i++) {
          if (items[i].severity === UR.SEVERITY.BLOCKING) { return true; }
        }
        return false;
      },

      count: function () { return items.length; }
    };

    return api;
  }

  UR.diagnostics = { create: create };

})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * calculationReferenceSheet.js - renders the rule registries into the shape
 * used by both the in-app Calculation Reference page and the exported
 * Calculation Reference worksheet (spec 12.3, 13, Appendix B).
 *
 * There is deliberately no second copy of any definition here: every field is
 * read from calculationRules.js, reviewRules.js, or dataQualityRules.js, with
 * threshold values resolved against the configuration actually used for the run.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  var COLUMNS = [
    'Rule ID', 'Rule version', 'Name', 'Classification', 'Definition',
    'Formula or logic', 'Inputs', 'Inclusions', 'Exclusions', 'Thresholds',
    'Null / open handling', 'Source references', 'Notes'
  ];

  function refText(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var ref = UR.referenceById(ids[i]);
      out.push(ref ? (ref.id + ' ' + ref.title) : ids[i]);
    }
    return out.join('; ');
  }

  function joinList(list) {
    return (list && list.length) ? list.join('; ') : '';
  }

  var calculationReferenceSheet = {
    COLUMNS: COLUMNS,

    /* One row per calculation rule. */
    calculationRows: function (config) {
      var rows = [];
      var rules = UR.calculationRules.RULES;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        rows.push([
          r.id, r.version, r.name, r.classification, r.definition, r.formula,
          joinList(r.inputs), joinList(r.inclusions), joinList(r.exclusions),
          joinList(UR.calculationRules.describeThresholds(r, config)),
          r.nullHandling, refText(r.sourceRefs), r.notes
        ]);
      }
      return rows;
    },

    /* One row per review trigger. */
    reviewRows: function (config) {
      var rows = [];
      var rules = UR.reviewRules.RULES;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        rows.push([
          r.id, r.version, r.name, r.classification,
          r.definition + ' Trigger: ' + r.trigger, r.formula,
          joinList(r.fields), 'See trigger.', 'See notes.',
          joinList(UR.calculationRules.describeThresholds(r, config)),
          'Open encounters and records excluded by data-quality rules do not appear unless the rule states otherwise.',
          refText(r.sourceRefs),
          r.notes + (r.relatedRules && r.relatedRules.length ? ' Related metrics: ' + r.relatedRules.join(', ') + '.' : '')
        ]);
      }
      return rows;
    },

    /* One row per data-quality check. */
    dataQualityRows: function () {
      var rows = [];
      var rules = UR.dataQualityRules.RULES;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        rows.push([
          r.id, r.version, r.name, r.classification, r.description,
          'Detected during import, normalization, or linkage.',
          '', '', '', 'Default severity: ' + r.severity, r.effect, refText(['HOSP']), ''
        ]);
      }
      return rows;
    },

    /* Full worksheet body including section headers. */
    allRows: function (config) {
      var rows = [];
      rows.push(['CALCULATION RULES']);
      rows.push(COLUMNS);
      rows = rows.concat(calculationReferenceSheet.calculationRows(config));
      rows.push([]);
      rows.push(['REVIEW QUEUE TRIGGERS - objective identification only; no clinical, medical-necessity, denial, or compliance conclusion is expressed by any rule below']);
      rows.push(COLUMNS);
      rows = rows.concat(calculationReferenceSheet.reviewRows(config));
      rows.push([]);
      rows.push(['DATA QUALITY RULES']);
      rows.push(COLUMNS);
      rows = rows.concat(calculationReferenceSheet.dataQualityRows());
      rows.push([]);
      rows.push(['EXTERNAL REFERENCES']);
      rows.push(['Reference', 'Title', 'Note', 'URL']);
      for (var i = 0; i < UR.REFERENCES.length; i++) {
        var ref = UR.REFERENCES[i];
        rows.push([ref.id, ref.title, ref.note, ref.url]);
      }
      rows.push([]);
      rows.push(['These references support the initial regulatory-surveillance design and should be rechecked whenever calculation rules or payer workflows are revised.']);
      rows.push(['This software is not a substitute for current CMS, payer, contract, or Arkansas regulatory guidance, and it does not make clinical or compliance determinations.']);
      return rows;
    },

    /* Structured records for the in-app reference page. */
    records: function (config) {
      var out = [];
      var i, r;
      for (i = 0; i < UR.calculationRules.RULES.length; i++) {
        r = UR.calculationRules.RULES[i];
        out.push({
          group: 'Calculation', id: r.id, version: r.version, name: r.name,
          classification: r.classification, definition: r.definition, formula: r.formula,
          inputs: r.inputs, inclusions: r.inclusions, exclusions: r.exclusions,
          thresholds: UR.calculationRules.describeThresholds(r, config),
          nullHandling: r.nullHandling, sourceRefs: r.sourceRefs, notes: r.notes
        });
      }
      for (i = 0; i < UR.reviewRules.RULES.length; i++) {
        r = UR.reviewRules.RULES[i];
        out.push({
          group: 'Review trigger', id: r.id, version: r.version, name: r.name,
          classification: r.classification, definition: r.definition + ' Trigger: ' + r.trigger,
          formula: r.formula, inputs: r.fields, inclusions: [], exclusions: [],
          thresholds: UR.calculationRules.describeThresholds(r, config),
          nullHandling: '', sourceRefs: r.sourceRefs, notes: r.notes
        });
      }
      for (i = 0; i < UR.dataQualityRules.RULES.length; i++) {
        r = UR.dataQualityRules.RULES[i];
        out.push({
          group: 'Data quality', id: r.id, version: r.version, name: r.name,
          classification: r.classification, definition: r.description,
          formula: '', inputs: [], inclusions: [], exclusions: [],
          thresholds: ['Default severity = ' + r.severity],
          nullHandling: r.effect, sourceRefs: ['HOSP'], notes: ''
        });
      }
      return out;
    }
  };

  UR.calculationReferenceSheet = calculationReferenceSheet;

})(typeof globalThis !== 'undefined' ? globalThis : this);

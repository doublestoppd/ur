/*
 * headerMapper.js - canonical field definitions and automatic header mapping
 * (spec 5, 6).
 *
 * Two rules govern this module:
 *   1. Exact known CPSI field names win outright.
 *   2. When two source columns are equally plausible for one canonical field,
 *      the tool refuses to choose and asks the user (spec 6.1).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  /*
   * requirement:
   *   required    - processing is blocked unless the field is mapped
   *   strong      - processing continues, precision degrades, warning raised
   *   recommended - processing continues, some metrics unavailable
   *   optional    - no effect on metrics
   * degradable    - a required field the user may explicitly proceed without,
   *                 accepting the listed loss of capability (spec 6.2).
   */
  var FIELDS = [
    {
      key: 'mrn', label: 'Patient MRN', cpsi: 'visit_mr_num', requirement: 'required', degradable: true,
      use: 'Patient-level identifier, stable across accounts. Drives transition linkage and readmission logic.',
      degradedEffect: 'Status-transition linkage, episode construction, and readmission indicators are disabled. Every account becomes its own episode.',
      aliases: ['visit_mr_num', 'mrn', 'mr num', 'mr number', 'medical record number', 'medical record', 'medical record #', 'patient id', 'patient mrn', 'mr no']
    },
    {
      key: 'account', label: 'Account / encounter number', cpsi: 'ipv1_num', requirement: 'required', degradable: true,
      use: 'Unique encounter/account identifier.',
      degradedEffect: 'Synthetic identifiers are assigned so rows stay traceable, but duplicate detection and account-level review lists lose their source reference.',
      aliases: ['ipv1_num', 'account', 'account number', 'account #', 'acct', 'acct number', 'encounter number', 'encounter', 'visit number', 'visit no', 'patient account number']
    },
    {
      key: 'name', label: 'Patient name', cpsi: 'visit_name', requirement: 'optional', degradable: true,
      use: 'Review-list readability only. Never persisted by the application.',
      degradedEffect: 'Review lists identify patients by account and MRN only.',
      aliases: ['visit_name', 'patient name', 'name', 'patient', 'pt name']
    },
    {
      key: 'service', label: 'Service code', cpsi: 'visit_servicecd_key', requirement: 'required', degradable: false,
      use: 'Classifies each account as IP, OS, SB, ignored, or unknown.',
      degradedEffect: '',
      aliases: ['visit_servicecd_key', 'service code', 'service', 'servicecd', 'service cd', 'patient type', 'pt type', 'service type']
    },
    {
      key: 'admitDate', label: 'Admission date', cpsi: 'ipv1_ad_date', requirement: 'required', degradable: false,
      use: 'Start of the service interval.',
      degradedEffect: '',
      aliases: ['ipv1_ad_date', 'admission date', 'admit date', 'adm date', 'ad date', 'date of admission', 'admitted date']
    },
    {
      key: 'admitTime', label: 'Admission time', cpsi: 'ipv1_ad_time', requirement: 'strong', degradable: true,
      use: 'Precise durations and transition timing.',
      degradedEffect: 'Admission is assumed to occur at midnight. Hour-based metrics, the 4-minute-gap transition logic, and observation thresholds lose accuracy.',
      aliases: ['ipv1_ad_time', 'admission time', 'admit time', 'adm time', 'ad time', 'time of admission']
    },
    {
      key: 'dischargeDate', label: 'Discharge date', cpsi: 'ipv1_dis_date', requirement: 'required', degradable: true,
      use: 'End of the service interval. Blank marks an open encounter.',
      degradedEffect: 'Every encounter is treated as open: no LOS, ALOS, readmission, or disposition metric can be produced.',
      aliases: ['ipv1_dis_date', 'discharge date', 'dis date', 'disch date', 'dc date', 'date of discharge']
    },
    {
      key: 'dischargeTime', label: 'Discharge time', cpsi: 'ipv1_dis_time', requirement: 'strong', degradable: true,
      use: 'Precise durations and transition timing.',
      degradedEffect: 'Discharge is assumed to occur at midnight. Hour-based metrics and transition gaps lose accuracy.',
      aliases: ['ipv1_dis_time', 'discharge time', 'dis time', 'disch time', 'dc time', 'time of discharge']
    },
    {
      key: 'insurance', label: 'Insurance code', cpsi: 'visit_ins', requirement: 'recommended', degradable: true,
      use: 'Mapped through the editable payer table into a payer category.',
      degradedEffect: 'All payer-mix, Medicare notice, and two-midnight review rules are unavailable.',
      aliases: ['visit_ins', 'insurance', 'insurance code', 'ins code', 'ins', 'payer', 'payor', 'payer code', 'financial class', 'primary insurance']
    },
    {
      key: 'dischargeCode', label: 'Discharge code', cpsi: 'ipv1_discd', requirement: 'recommended', degradable: true,
      use: 'Primary signal for internal status transitions (B, Q, V) and for disposition and mortality.',
      degradedEffect: 'No internal transition can be detected, so OS -> IP conversions cannot be counted and every status change is treated as a separate episode. Deaths and dispositions are unavailable.',
      aliases: ['ipv1_discd', 'discharge code', 'disposition code', 'dis code', 'disch code', 'discd', 'discharge disposition', 'dc code']
    },
    {
      key: 'admissionSource', label: 'Admission source', cpsi: '', requirement: 'recommended', degradable: true,
      use: 'Numeric source-of-admission value, mapped through the editable reference table.',
      degradedEffect: 'The admission-source summary is unavailable.',
      aliases: ['admission source', 'admit source', 'source of admission', 'adm source', 'source code', 'admission source code', 'point of origin']
    }
  ];

  var fieldByKey = {};
  for (var i = 0; i < FIELDS.length; i++) { fieldByKey[FIELDS[i].key] = FIELDS[i]; }

  /* Normalize a header for comparison: trim, lowercase, punctuation to spaces. */
  function normalize(header) {
    return String(header === null || header === undefined ? '' : header)
      .replace(/[ ]/g, ' ')
      .toLowerCase()
      .replace(/[_\-\.\/\\#:;,()\[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var CONFIDENCE = {
    EXACT_CPSI: 1.0,   /* the documented CPSI field name */
    EXACT_ALIAS: 0.9,  /* a known alias, matched exactly after normalization */
    CONTAINS: 0.6      /* the header contains a known alias as a whole phrase */
  };

  /* Score one header against one canonical field. 0 means no match. */
  function score(field, header) {
    var norm = normalize(header);
    if (!norm) { return 0; }
    if (field.cpsi && norm === normalize(field.cpsi)) { return CONFIDENCE.EXACT_CPSI; }
    var best = 0;
    for (var a = 0; a < field.aliases.length; a++) {
      var alias = normalize(field.aliases[a]);
      if (!alias) { continue; }
      if (norm === alias) {
        best = Math.max(best, alias === normalize(field.cpsi) ? CONFIDENCE.EXACT_CPSI : CONFIDENCE.EXACT_ALIAS);
      } else if (alias.length >= 4 && (norm.indexOf(alias + ' ') === 0 || norm.indexOf(' ' + alias) === norm.length - alias.length - 1 || norm.indexOf(' ' + alias + ' ') >= 0)) {
        best = Math.max(best, CONFIDENCE.CONTAINS);
      }
    }
    return best;
  }

  var headerMapper = {
    FIELDS: FIELDS,
    CONFIDENCE: CONFIDENCE,
    normalize: normalize,
    field: function (key) { return fieldByKey[key] || null; },

    /*
     * Propose a mapping from canonical field key -> source column.
     * Returns { mapping, candidates, ambiguities, unmapped }.
     *
     *   mapping[key]     = { header, index, confidence, basis } or null
     *   candidates[key]  = every scoring column, best first
     *   ambiguities      = fields whose top two candidates tie (never auto-chosen)
     */
    autoMap: function (headers) {
      var mapping = {};
      var candidates = {};
      var ambiguities = [];
      var f, k;

      for (f = 0; f < FIELDS.length; f++) {
        var field = FIELDS[f];
        var scored = [];
        for (var h = 0; h < headers.length; h++) {
          var s = score(field, headers[h]);
          if (s > 0) { scored.push({ header: headers[h], index: h, confidence: s }); }
        }
        scored.sort(function (a, b) {
          if (b.confidence !== a.confidence) { return b.confidence - a.confidence; }
          return a.index - b.index;
        });
        candidates[field.key] = scored;
        mapping[field.key] = null;
      }

      /*
       * Assign highest-confidence pairs first so a column cannot be claimed by a
       * weaker field. A tie at the top for a field, or a contest for a column
       * that two fields both want at equal confidence, is reported rather than
       * resolved.
       */
      var claims = [];
      for (f = 0; f < FIELDS.length; f++) {
        k = FIELDS[f].key;
        var list = candidates[k];
        if (!list.length) { continue; }
        if (list.length > 1 && list[0].confidence === list[1].confidence) {
          ambiguities.push({
            field: k,
            reason: 'Two source columns match "' + fieldByKey[k].label + '" equally well.',
            columns: [list[0].header, list[1].header]
          });
          continue;
        }
        claims.push({ field: k, cand: list[0] });
      }

      claims.sort(function (a, b) { return b.cand.confidence - a.cand.confidence; });

      var takenByIndex = {};
      for (var c = 0; c < claims.length; c++) {
        var claim = claims[c];
        var idx = claim.cand.index;
        if (takenByIndex[idx] !== undefined) {
          var otherField = takenByIndex[idx];
          var otherConf = mapping[otherField].confidence;
          if (otherConf === claim.cand.confidence) {
            ambiguities.push({
              field: claim.field,
              reason: 'Column "' + claim.cand.header + '" matches both "' + fieldByKey[otherField].label +
                      '" and "' + fieldByKey[claim.field].label + '" equally well.',
              columns: [claim.cand.header]
            });
          }
          continue;
        }
        takenByIndex[idx] = claim.field;
        mapping[claim.field] = {
          header: claim.cand.header,
          index: idx,
          confidence: claim.cand.confidence,
          basis: claim.cand.confidence === CONFIDENCE.EXACT_CPSI ? 'Exact CPSI field name'
            : (claim.cand.confidence === CONFIDENCE.EXACT_ALIAS ? 'Known alias' : 'Partial header match')
        };
      }

      var unmapped = [];
      for (f = 0; f < FIELDS.length; f++) {
        if (!mapping[FIELDS[f].key]) { unmapped.push(FIELDS[f].key); }
      }

      return { mapping: mapping, candidates: candidates, ambiguities: ambiguities, unmapped: unmapped };
    },

    /*
     * Check a (possibly user-edited) mapping. Returns
     * { ok, blocking[], warnings[], degraded[] }.
     * `acknowledgedDegradations` lists field keys the user explicitly chose to
     * proceed without (spec 6.2).
     */
    validateMapping: function (mapping, acknowledgedDegradations) {
      var blocking = [];
      var warnings = [];
      var degraded = [];
      var acked = acknowledgedDegradations || [];

      /* One source column may not serve two canonical fields. */
      var usedIndex = {};
      for (var key in mapping) {
        if (!Object.prototype.hasOwnProperty.call(mapping, key)) { continue; }
        var m = mapping[key];
        if (!m) { continue; }
        if (usedIndex[m.index] !== undefined) {
          blocking.push({
            ruleId: 'DQ_MAP_AMBIGUOUS',
            message: 'Column "' + m.header + '" is mapped to both "' + fieldByKey[usedIndex[m.index]].label +
                     '" and "' + fieldByKey[key].label + '". Choose one.'
          });
        } else {
          usedIndex[m.index] = key;
        }
      }

      for (var f = 0; f < FIELDS.length; f++) {
        var field = FIELDS[f];
        if (mapping[field.key]) { continue; }
        if (field.requirement === 'required') {
          if (field.degradable && util.contains(acked, field.key)) {
            degraded.push({ field: field.key, label: field.label, effect: field.degradedEffect });
          } else {
            blocking.push({
              ruleId: 'DQ_MAP_REQUIRED',
              message: 'Required field "' + field.label + '" is not mapped.' +
                       (field.degradable ? ' You may proceed without it only by acknowledging that: ' + field.degradedEffect : '')
            });
          }
        } else if (field.requirement === 'strong' || field.requirement === 'recommended') {
          warnings.push({
            ruleId: 'DQ_MAP_REQUIRED',
            message: '"' + field.label + '" is not mapped. ' + field.degradedEffect
          });
          degraded.push({ field: field.key, label: field.label, effect: field.degradedEffect });
        }
      }

      return { ok: blocking.length === 0, blocking: blocking, warnings: warnings, degraded: degraded };
    }
  };

  UR.headerMapper = headerMapper;

})(typeof globalThis !== 'undefined' ? globalThis : this);

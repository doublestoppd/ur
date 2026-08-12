/*
 * attention.js - distills a processed run into the short list of things a user
 * actually needs to act on (the Overview digest).
 *
 * The full diagnostics, code inventory, and transition table still exist one
 * fold below - nothing is removed - but the digest is what the page LEADS
 * with: at most a handful of one-line items, each carrying a count and an
 * action that jumps to the place where the problem is fixed. A clean run
 * produces an empty list, which the UI renders as a single quiet success line.
 *
 * Pure data in, pure data out: no DOM here, so the triage logic is unit-tested
 * like every other judgement the tool makes.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  var SEV = UR.SEVERITY;

  function item(severity, message, action, count) {
    return { severity: severity, message: message, action: action || null, count: count || 0 };
  }

  /* "a, b, c and 4 more" - keeps digest lines one line. */
  function sampleList(values, limit) {
    var cap = limit || 4;
    if (values.length <= cap) { return values.join(', '); }
    return values.slice(0, cap).join(', ') + ' and ' + (values.length - cap) + ' more';
  }

  var attention = {

    /*
     * Returns digest items sorted Blocking -> Error -> Warning -> Info.
     * Actions: { view } to open a page, plus optional { tab } for a Rules tab,
     * { status } / { search } presets for the Accounts view, or { expand } with
     * the id of a fold on the Overview itself.
     */
    build: function (state) {
      var items = [];
      var byRule = state.diagnostics.byRule(6);
      var i, g;

      /* ------------------------------------------------- blocked runs */
      if (state.blocked) {
        var blockingActions = {
          DQ_MAP_REQUIRED: { view: 'map' },
          DQ_MAP_AMBIGUOUS: { view: 'map' },
          DQ_SERVICE_COLUMN: { view: 'rules', tab: 'serviceCodes' },
          DQ_DATE_COLUMN: { view: 'map' },
          DQ_NO_ROWS: { view: 'import' }
        };
        for (i = 0; i < byRule.length; i++) {
          g = byRule[i];
          if (g.severity !== SEV.BLOCKING) { continue; }
          items.push(item(SEV.BLOCKING, g.messages[0] || g.name,
            blockingActions[g.ruleId] || { view: 'map' }, g.count));
        }
        return items;
      }

      /* -------------------------------------------------------- errors */
      var counts = state.diagnostics.counts();
      if (counts.Error > 0) {
        items.push(item(SEV.ERROR,
          counts.Error + ' finding(s) excluded rows or values from the metrics.',
          { expand: 'ov-diagnostics' }, counts.Error));
      }

      /* --------------------------------------- unrecognized codes, per table */
      var tabFor = {
        'Service code': 'serviceCodes',
        'Discharge code': 'dischargeCodes',
        'Insurance code': 'insuranceCodes',
        'Admission source': 'admissionSources'
      };
      for (i = 0; i < (state.codeInventory || []).length; i++) {
        var section = state.codeInventory[i];
        var unknown = [];
        var affected = 0;
        for (var r = 0; r < section.rows.length; r++) {
          var row = section.rows[r];
          if (row.status !== UR.codeInventory.STATUS.UNRECOGNIZED) { continue; }
          if (row.value === '(blank)') { continue; }
          unknown.push(row.value);
          affected += row.count;
        }
        if (!unknown.length) { continue; }
        items.push(item(SEV.WARNING,
          unknown.length + ' unrecognized ' + section.type.toLowerCase() + '(s) on ' + affected +
          ' row(s): ' + sampleList(unknown) + '.',
          { view: 'rules', tab: tabFor[section.type] || 'serviceCodes' }, unknown.length));
      }

      /* -------------------------------------------- retired / ambiguous codes */
      for (i = 0; i < byRule.length; i++) {
        g = byRule[i];
        if (g.ruleId === 'DQ_CODE_RETIRED') {
          items.push(item(SEV.WARNING,
            g.count + ' account(s) carry an insurance code the hospital marks "do not use"' +
            (g.samples.length ? ' (e.g. ' + sampleList(g.samples, 3) + ')' : '') + '.',
            { view: 'rules', tab: 'insuranceCodes' }, g.count));
        }
        if (g.ruleId === 'DQ_CODE_AMBIGUOUS') {
          items.push(item(SEV.WARNING,
            g.count + ' code(s) match more than one reference entry once case or leading zeros are ignored; no mapping was applied.',
            { expand: 'ov-diagnostics' }, g.count));
        }
      }

      /* -------------------------------------------------- transition problems */
      var LC = UR.LINK_CONFIDENCE;
      var trouble = { refused: 0, ambiguous: 0, missing: 0, uncoded: 0 };
      for (i = 0; i < (state.transitions || []).length; i++) {
        var t = state.transitions[i];
        if (t.confidence === LC.REFUSED) { trouble.refused++; }
        else if (t.confidence === LC.AMBIGUOUS) { trouble.ambiguous++; }
        else if (t.confidence === LC.MISSING) { trouble.missing++; }
        else if (t.confidence === LC.UNLINKED) { trouble.uncoded++; }
      }
      var troubleTotal = trouble.refused + trouble.ambiguous + trouble.missing + trouble.uncoded;
      if (troubleTotal > 0) {
        var parts = [];
        if (trouble.refused) { parts.push(trouble.refused + ' refused on contradictory times'); }
        if (trouble.ambiguous) { parts.push(trouble.ambiguous + ' ambiguous'); }
        if (trouble.missing) { parts.push(trouble.missing + ' missing a successor'); }
        if (trouble.uncoded) { parts.push(trouble.uncoded + ' possible but uncoded'); }
        items.push(item(SEV.WARNING,
          troubleTotal + ' status transition(s) could not be linked cleanly: ' + parts.join(', ') + '.',
          { expand: 'ov-transitions' }, troubleTotal));
      }

      /* ------------------------------------------------------ informational */
      var lookback = state.readmissions && state.readmissions.lookback;
      if (lookback && lookback.affectedEpisodes > 0) {
        items.push(item(SEV.INFO,
          'Readmission counts are incomplete for the first ' + lookback.windowDays +
          ' days of the imported range (' + lookback.affectedEpisodes +
          ' episode(s) affected). Import the preceding month to close the gap.',
          { expand: 'ov-diagnostics' }, lookback.affectedEpisodes));
      }

      if (state.counts && state.counts.open > 0) {
        items.push(item(SEV.INFO,
          state.counts.open + ' encounter(s) still open at export time - excluded from discharged-stay averages.',
          { view: 'accounts', status: 'open' }, state.counts.open));
      }

      if (state.reviewQueue && state.reviewQueue.byAccount.length > 0) {
        items.push(item(SEV.INFO,
          state.reviewQueue.byAccount.length + ' account(s) on the review queue.',
          { view: 'review' }, state.reviewQueue.byAccount.length));
      }

      items.sort(function (a, b) {
        return UR.SEVERITY_ORDER.indexOf(a.severity) - UR.SEVERITY_ORDER.indexOf(b.severity);
      });
      return items;
    },

    /* True when the digest carries anything above Info. */
    hasProblems: function (items) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].severity !== SEV.INFO) { return true; }
      }
      return false;
    }
  };

  UR.attention = attention;

})(typeof globalThis !== 'undefined' ? globalThis : this);

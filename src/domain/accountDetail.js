/*
 * accountDetail.js - assembles the per-account browser list and the full
 * patient dossier behind it.
 *
 * PURPOSE: verification. The dossier exists so a reviewer can sit in front of
 * the actual charting system and check, account by account, that this tool read
 * the export correctly. That means it must show three things together for every
 * visit:
 *
 *   1. the SOURCE CELL exactly as it arrived, and the column it came from,
 *   2. the INTERPRETED value the engine derived from it,
 *   3. every judgement the engine made about the record - the service
 *      classification, the payer mapping, each transition it accepted, each one
 *      it refused and why, and every diagnostic raised against it.
 *
 * Nothing is summarized away: excluded records appear alongside included ones,
 * because "why is this account missing from the count" is exactly the question
 * a verification pass needs to answer.
 *
 * No drawing code here, so the assembly is unit-testable.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  /* Worst severity among a set of diagnostics, or '' when there are none. */
  function worstSeverity(items) {
    var worst = '';
    for (var i = 0; i < items.length; i++) {
      if (!worst || UR.SEVERITY_ORDER.indexOf(items[i].severity) < UR.SEVERITY_ORDER.indexOf(worst)) {
        worst = items[i].severity;
      }
    }
    return worst;
  }

  function statusOf(e) {
    if (!e.included) {
      return { label: 'Excluded', detail: e.excludedReason || 'Service code not included' };
    }
    if (!e.metricEligible) {
      return { label: 'Excluded', detail: e.excludedReason || 'Excluded by a data-quality rule' };
    }
    if (e.isOpen) { return { label: 'Open', detail: 'Still in house at export time' }; }
    return { label: 'Included', detail: '' };
  }

  var accountDetail = {

    /*
     * One row per imported account, chronological. Includes excluded records:
     * the list is the index of everything that was read, not of what counted.
     */
    list: function (state) {
      var reviewByAccount = {};
      var i;
      if (state.reviewQueue) {
        for (i = 0; i < state.reviewQueue.rows.length; i++) {
          var r = state.reviewQueue.rows[i];
          if (!reviewByAccount[r.account]) { reviewByAccount[r.account] = []; }
          if (reviewByAccount[r.account].indexOf(r.ruleId) < 0) { reviewByAccount[r.account].push(r.ruleId); }
        }
      }

      var rows = [];
      for (i = 0; i < state.encounters.length; i++) {
        var e = state.encounters[i];
        var status = statusOf(e);
        var flags = e.flags || [];
        rows.push({
          rowId: e.rowId,
          account: e.account,
          accountSynthetic: e.accountSynthetic,
          mrn: e.mrn,
          patientName: e.name,
          serviceRaw: e.serviceRaw,
          serviceClass: e.serviceClass,
          admitDT: e.admitDT,
          dischargeDT: e.dischargeDT,
          isOpen: e.isOpen,
          durationHours: e.durationHours,
          midnights: e.midnights,
          payerCategory: e.payerCategory,
          dischargeCodeRaw: e.dischargeCodeRaw,
          episodeId: e.episodeId,
          status: status.label,
          statusDetail: status.detail,
          inPeriod: !!(state.period && e.admitDT && UR.scope.inPeriod(e.admitDT, state.period)),
          reviewRuleIds: reviewByAccount[e.account] || [],
          diagnosticCount: flags.length,
          worstSeverity: worstSeverity(flags),
          sourceFile: e.sourceFile,
          sourceSheet: e.sourceSheet,
          sourceRowNumber: e.sourceRowNumber
        });
      }

      rows.sort(function (a, b) {
        var ta = a.admitDT ? a.admitDT.getTime() : 0;
        var tb = b.admitDT ? b.admitDT.getTime() : 0;
        if (ta !== tb) { return ta - tb; }
        return a.account < b.account ? -1 : (a.account > b.account ? 1 : 0);
      });
      return rows;
    },

    /* Case-insensitive search across account, MRN, and name. */
    search: function (rows, query, filters) {
      var f = filters || {};
      var q = String(query || '').trim().toLowerCase();
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (q) {
          var hay = (row.account + ' ' + row.mrn + ' ' + row.patientName + ' ' + row.episodeId).toLowerCase();
          if (hay.indexOf(q) < 0) { continue; }
        }
        if (f.service && row.serviceClass !== f.service) { continue; }
        if (f.status === 'included' && row.status !== 'Included') { continue; }
        if (f.status === 'excluded' && row.status !== 'Excluded') { continue; }
        if (f.status === 'open' && !row.isOpen) { continue; }
        if (f.status === 'flagged' && !row.diagnosticCount && !row.reviewRuleIds.length) { continue; }
        if (f.status === 'review' && !row.reviewRuleIds.length) { continue; }
        out.push(row);
      }
      return out;
    },

    /*
     * Source-versus-interpreted comparison for one encounter: the table that
     * makes verification against the chart possible.
     */
    fieldComparison: function (encounter) {
      var rows = [];
      var fields = UR.headerMapper.FIELDS;

      function interpreted(key, e) {
        switch (key) {
          case 'mrn': return e.mrn || '(none)';
          case 'account': return e.account + (e.accountSynthetic ? ' (assigned: the source row had no account number)' : '');
          case 'name': return e.name || '(none)';
          case 'service':
            return e.serviceClass === UR.SERVICE.UNKNOWN ? 'Unrecognized - excluded from all metrics'
              : (e.serviceClass === UR.SERVICE.IGNORED ? 'Configured as ignored - excluded by policy'
                : 'Included as ' + e.serviceClass + (e.serviceLabel ? ' (' + e.serviceLabel + ')' : ''));
          case 'admitDate':
          case 'admitTime':
            return e.admitDT ? util.fmtDateTime(e.admitDT) + (e.admitTimeAssumed ? ' - midnight assumed, no usable time' : '') : '(not usable)';
          case 'dischargeDate':
          case 'dischargeTime':
            return e.isOpen ? '(open encounter - no discharge)'
              : (e.dischargeDT ? util.fmtDateTime(e.dischargeDT) + (e.dischargeTimeAssumed ? ' - midnight assumed, no usable time' : '') : '(not usable)');
          case 'insurance':
            return e.payerCategory + (e.payerLabel ? ' (' + e.payerLabel + ')' : '');
          case 'dischargeCode':
            if (!e.dischargeCodeRaw) { return '(none)'; }
            return (e.dischargeCodeLabel || 'Unrecognized code') +
              ' | disposition: ' + (e.dispositionCategory || 'Unknown') +
              (e.transitionTo ? ' | expects a following ' + e.transitionTo + ' account' : '');
          case 'admissionSource':
            return e.admissionSourceLabel || (e.admissionSourceRaw ? 'Unmapped' : '(none)');
          default: return '';
        }
      }

      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        var raw = encounter.raw[field.key] || { column: null, value: null };
        rows.push({
          field: field.label,
          column: raw.column || '(not mapped)',
          rawValue: raw.value === null || raw.value === undefined || raw.value === ''
            ? '(blank)' : String(raw.value),
          rawType: raw.type,
          interpreted: interpreted(field.key, encounter)
        });
      }
      return rows;
    },

    /* Derived values that come from combining fields rather than reading one. */
    derivedValues: function (encounter, state) {
      var rows = [];
      var e = encounter;
      rows.push({ label: 'Service interval', value: e.admitDT ? util.fmtDateTime(e.admitDT) + '  to  ' + (e.isOpen ? '(open)' : util.fmtDateTime(e.dischargeDT)) : '(not usable)' });
      rows.push({
        label: 'Elapsed duration',
        value: e.durationHours === null ? '(not calculated)'
          : util.round(e.durationHours, 2) + ' hours  =  ' + util.round(e.durationDays, 3) + ' days'
      });
      rows.push({
        label: 'Midnights crossed',
        value: e.midnights === null ? '(not calculated)' : String(e.midnights),
        note: 'Counted from calendar boundaries, not from hours / 24.'
      });
      rows.push({ label: 'Payer category', value: e.payerCategory });
      rows.push({ label: 'Disposition category', value: e.dispositionCategory || '(none)' });
      rows.push({ label: 'Counted as a death', value: e.isDeath ? 'Yes' : 'No' });
      rows.push({ label: 'Episode', value: e.episodeId || '(not part of an episode)' });
      rows.push({ label: 'Service sequence of that episode', value: e.episodeServiceSequence || '-' });
      rows.push({
        label: 'Inside the reporting period',
        value: state.period && e.admitDT
          ? (UR.scope.inPeriod(e.admitDT, state.period) ? 'Yes - admitted within ' + state.period.label
            : 'No - admitted outside ' + state.period.label + ', kept as context only')
          : '(unknown)'
      });
      rows.push({
        label: 'Counts toward metrics',
        value: e.metricEligible ? 'Yes' : 'No - ' + (e.excludedReason || 'excluded by a data-quality rule')
      });
      rows.push({ label: 'Source', value: e.sourceFile + ' | sheet ' + e.sourceSheet + ' | row ' + e.sourceRowNumber });
      return rows;
    },

    /*
     * The full dossier for the patient owning an account.
     *
     * Keyed by MRN when there is one, because the unit a reviewer verifies is a
     * patient's course, not a single CPSI account. A record with no MRN stands
     * alone, which is itself worth seeing.
     */
    forAccount: function (state, account) {
      var i, j;
      var target = null;
      for (i = 0; i < state.encounters.length; i++) {
        if (state.encounters[i].account === account) { target = state.encounters[i]; break; }
      }
      if (!target) { return null; }

      var siblings = [];
      if (target.mrn) {
        for (i = 0; i < state.encounters.length; i++) {
          if (state.encounters[i].mrn === target.mrn) { siblings.push(state.encounters[i]); }
        }
      } else {
        siblings = [target];
      }
      siblings.sort(function (a, b) {
        var ta = a.admitDT ? a.admitDT.getTime() : 0;
        var tb = b.admitDT ? b.admitDT.getTime() : 0;
        return ta !== tb ? ta - tb : (a.account < b.account ? -1 : 1);
      });

      var rowIds = {};
      var accounts = {};
      for (i = 0; i < siblings.length; i++) {
        rowIds[siblings[i].rowId] = true;
        accounts[siblings[i].account] = true;
      }

      /* Episodes this patient's accounts belong to. */
      var episodes = [];
      var seenEpisode = {};
      for (i = 0; i < siblings.length; i++) {
        var epId = siblings[i].episodeId;
        if (!epId || seenEpisode[epId]) { continue; }
        seenEpisode[epId] = true;
        if (state.episodesById && state.episodesById[epId]) { episodes.push(state.episodesById[epId]); }
      }

      /*
       * Every transition attempt touching this patient, accepted or refused.
       * The refusals matter most: they explain why two accounts that look
       * continuous in the chart are separate episodes here.
       */
      var transitions = [];
      for (i = 0; i < state.transitions.length; i++) {
        var t = state.transitions[i];
        if (rowIds[t.fromRowId] || (t.toRowId && rowIds[t.toRowId])) { transitions.push(t); }
      }

      /* Readmission pairs involving this patient. */
      var readmissions = [];
      if (state.readmissions) {
        for (i = 0; i < state.readmissions.pairs.length; i++) {
          if (state.readmissions.pairs[i].mrn === target.mrn && target.mrn) {
            readmissions.push(state.readmissions.pairs[i]);
          }
        }
      }

      /* Review-queue rows and diagnostics against any of these accounts. */
      var reviewRows = [];
      if (state.reviewQueue) {
        for (i = 0; i < state.reviewQueue.rows.length; i++) {
          if (accounts[state.reviewQueue.rows[i].account]) { reviewRows.push(state.reviewQueue.rows[i]); }
        }
      }

      var diagnostics = [];
      var all = state.diagnostics.all();
      for (i = 0; i < all.length; i++) {
        if (accounts[all[i].account]) { diagnostics.push(all[i]); }
      }

      /* Per-visit detail, in the order the patient experienced them. */
      var visits = [];
      for (i = 0; i < siblings.length; i++) {
        var e = siblings[i];
        var visitDiagnostics = [];
        for (j = 0; j < diagnostics.length; j++) {
          if (diagnostics[j].account === e.account) { visitDiagnostics.push(diagnostics[j]); }
        }
        var visitReview = [];
        for (j = 0; j < reviewRows.length; j++) {
          if (reviewRows[j].account === e.account) { visitReview.push(reviewRows[j]); }
        }
        var visitTransitions = [];
        for (j = 0; j < transitions.length; j++) {
          if (transitions[j].fromRowId === e.rowId || transitions[j].toRowId === e.rowId) {
            visitTransitions.push(transitions[j]);
          }
        }
        visits.push({
          encounter: e,
          status: statusOf(e),
          fields: accountDetail.fieldComparison(e),
          derived: accountDetail.derivedValues(e, state),
          diagnostics: visitDiagnostics,
          reviewRows: visitReview,
          transitions: visitTransitions,
          linkedFrom: e.linkPrev,
          linkedTo: e.linkNext
        });
      }

      return {
        account: account,
        mrn: target.mrn,
        patientName: target.name,
        hasMrn: !!target.mrn,
        visits: visits,
        episodes: episodes,
        transitions: transitions,
        readmissions: readmissions,
        reviewRows: reviewRows,
        diagnostics: diagnostics,
        totals: {
          visits: siblings.length,
          episodes: episodes.length,
          included: (function () {
            var n = 0;
            for (var k = 0; k < siblings.length; k++) { if (siblings[k].metricEligible) { n++; } }
            return n;
          })(),
          acceptedTransitions: (function () {
            var n = 0;
            for (var k = 0; k < transitions.length; k++) {
              if (transitions[k].confidence === UR.LINK_CONFIDENCE.CONFIRMED ||
                  transitions[k].confidence === UR.LINK_CONFIDENCE.PROBABLE) { n++; }
            }
            return n;
          })()
        }
      };
    }
  };

  UR.accountDetail = accountDetail;

})(typeof globalThis !== 'undefined' ? globalThis : this);

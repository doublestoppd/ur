/*
 * transitionLinker.js - reconstruct CPSI internal status transitions
 * (spec 8.2, 8.3).
 *
 * CPSI opens a new account whenever a patient changes status, so a single
 * hospital course arrives as several rows. This module reconnects them using
 * the discharge code as the primary signal and timing only as confirmation.
 *
 * It never links on timing alone (spec 8.3 step 9), and never guesses between
 * two plausible candidates (step 7). Both situations become diagnostics.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var LC = UR.LINK_CONFIDENCE;

  function sortForLinking(a, b) {
    var ta = a.admitDT ? a.admitDT.getTime() : 0;
    var tb = b.admitDT ? b.admitDT.getTime() : 0;
    if (ta !== tb) { return ta - tb; }
    /* Deterministic tie-breaker (spec 8.3 step 2). */
    return a.account < b.account ? -1 : (a.account > b.account ? 1 : 0);
  }

  /*
   * The service pairs a named metric specifically models: OS->IP (OSIP_001),
   * IP->SB (IPSB_001), SB->IP (SBIP_001), OS->SB (OSSB_001). An accepted link
   * outside this set - IP->OS, for example - is kept, because the episode is
   * real, but warned about: it is counted in no named transition figure and
   * may indicate a mis-mapped discharge code.
   *
   * (A Condition Code 44 status change does NOT arrive as an IP->OS account
   * pair in this hospital's exports - the stay is re-registered and simply
   * looks like an ordinary observation account - so no Code 44 inference is
   * attempted from account sequences.)
   */
  var MODELED_PAIRS = { 'OS|IP': 1, 'IP|SB': 1, 'SB|IP': 1, 'OS|SB': 1 };

  var transitionLinker = {

    /*
     * Returns { transitions } where each entry describes one attempted internal
     * status change, accepted or not:
     *
     *   { fromRowId, toRowId, fromAccount, toAccount, mrn, fromService,
     *     toService, expectedService, dischargeCode, gapMinutes, sameDay,
     *     confidence, issue, candidateAccounts }
     *
     * Accepted links (Confirmed / Probable) also set linkNext / linkPrev on the
     * encounter records so the episode builder can walk the chain.
     */
    linkTransitions: function (encounters, config, diag) {
      var settings = config.transition;
      var maxGapMin = settings.maxGapMinutes;
      var overlapTolMin = settings.overlapToleranceMinutes;
      var requireSameDay = settings.requireSameCalendarDate;
      var suspiciousMin = settings.suspiciousGapMinutes;
      var uncodedWindowMin = settings.uncodedTransitionWindowMinutes;

      var transitions = [];

      /* Only linkable records participate: included service, valid admit, Patient ID. */
      var linkable = [];
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (e.metricEligible && e.mrn && e.admitDT) { linkable.push(e); }
      }

      var grouped = util.groupBy(linkable, function (e) { return e.mrn; });

      for (var g = 0; g < grouped.keys.length; g++) {
        var list = grouped.map[grouped.keys[g]].slice().sort(sortForLinking);

        /* ------------------------------------- coded transitions (steps 3-8) */
        for (var a = 0; a < list.length; a++) {
          var from = list[a];
          if (!from.transitionTo) { continue; }

          var rec = {
            fromRowId: from.rowId, toRowId: null,
            fromAccount: from.account, toAccount: '',
            mrn: from.mrn,
            fromService: from.serviceClass, toService: '',
            expectedService: from.transitionTo,
            dischargeCode: from.dischargeCodeRaw,
            fromDischarge: from.dischargeDT, toAdmit: null,
            gapMinutes: null, sameDay: null,
            confidence: LC.MISSING, issue: '', candidateAccounts: []
          };

          if (!from.dischargeDT) {
            rec.issue = 'The discharging account has no usable discharge datetime, so no successor can be matched.';
            diag.addFor('DQ_TRANS_MISSING', from, {
              message: 'Account ' + from.account + ' carries transition code "' + from.dischargeCodeRaw +
                       '" but has no discharge datetime, so the expected ' + from.transitionTo + ' successor cannot be matched.'
            });
            transitions.push(rec);
            continue;
          }

          var disMs = from.dischargeDT.getTime();
          var candidates = [];
          var wrongService = [];
          var farOverlap = [];

          for (var b = 0; b < list.length; b++) {
            var to = list[b];
            if (to === from || to.takenAsSuccessor) { continue; }
            if (!to.admitDT) { continue; }
            var gapMinutes = (to.admitDT.getTime() - disMs) / 60000;
            if (gapMinutes > maxGapMin) { continue; }
            var sameDay = util.dayIndex(to.admitDT) === util.dayIndex(from.dischargeDT);
            if (requireSameDay && !sameDay) { continue; }
            if (gapMinutes < -overlapTolMin) {
              /*
               * The expected successor exists but its admission is recorded
               * EARLIER than this discharge by more than the tolerance -
               * registration entered contradictory times. Collected so the
               * refusal can name both accounts instead of surfacing as a
               * "missing successor" beside an unrelated "unexplained overlap".
               */
              if (to.serviceClass === from.transitionTo) {
                farOverlap.push({ enc: to, gapMinutes: gapMinutes });
              }
              continue;
            }
            if (to.serviceClass !== from.transitionTo) {
              wrongService.push({ enc: to, gapMinutes: gapMinutes });
              continue;
            }
            candidates.push({ enc: to, gapMinutes: gapMinutes, sameDay: sameDay });
          }
          farOverlap.sort(function (x, y) { return Math.abs(x.gapMinutes) - Math.abs(y.gapMinutes); });

          /* Step 4: smallest nonnegative gap first; overlaps rank last. */
          candidates.sort(function (x, y) {
            var xNeg = x.gapMinutes < 0 ? 1 : 0;
            var yNeg = y.gapMinutes < 0 ? 1 : 0;
            if (xNeg !== yNeg) { return xNeg - yNeg; }
            return Math.abs(x.gapMinutes) - Math.abs(y.gapMinutes);
          });

          for (var c = 0; c < candidates.length; c++) { rec.candidateAccounts.push(candidates[c].enc.account); }

          if (candidates.length === 0) {
            if (farOverlap.length) {
              var far = farOverlap[0];
              rec.confidence = LC.REFUSED;
              rec.toAccount = far.enc.account;
              rec.toRowId = far.enc.rowId;
              rec.toService = far.enc.serviceClass;
              rec.toAdmit = far.enc.admitDT;
              rec.gapMinutes = far.gapMinutes;
              rec.sameDay = true;
              rec.issue = 'The expected successor exists, but its admission is recorded ' +
                          util.round(-far.gapMinutes, 0) + ' minutes BEFORE this discharge - beyond the ' +
                          overlapTolMin + '-minute overlap tolerance. The registration times contradict the transition.';
              for (var fo = 0; fo < farOverlap.length; fo++) { rec.candidateAccounts.push(farOverlap[fo].enc.account); }
              diag.addFor('DQ_TRANS_OVERLAP_EXCEEDED', from, {
                message: 'Account ' + from.account + ' (' + from.serviceClass + ', code "' + from.dischargeCodeRaw +
                         '") expects a following ' + from.transitionTo + ' account. Account ' + far.enc.account +
                         ' (' + far.enc.serviceClass + ') admits ' + util.round(-far.gapMinutes, 0) +
                         ' minutes BEFORE the discharge of ' + from.account + ', beyond the ' + overlapTolMin +
                         '-minute overlap tolerance, so no link was made and the accounts stay in separate episodes. ' +
                         'If this is a genuine transition, the registration times disagree: correct the admission/discharge ' +
                         'times in the source system, or raise the overlap tolerance in Transition settings, and reprocess.'
              });
              transitions.push(rec);
              continue;
            }
            if (wrongService.length) {
              rec.issue = 'A subsequent account exists inside the timing tolerance but carries service ' +
                          wrongService[0].enc.serviceClass + ' instead of the expected ' + from.transitionTo + '.';
              rec.candidateAccounts.push(wrongService[0].enc.account);
              diag.addFor('DQ_TRANS_MISMATCH', from, {
                message: 'Account ' + from.account + ' (code "' + from.dischargeCodeRaw + '") expects a ' + from.transitionTo +
                         ' successor. Account ' + wrongService[0].enc.account + ' follows within ' +
                         util.round(wrongService[0].gapMinutes, 0) + ' minutes but is service ' + wrongService[0].enc.serviceClass +
                         '. No link was made.'
              });
            } else {
              rec.issue = 'No account with the expected service follows within the configured tolerance.';
              diag.addFor('DQ_TRANS_MISSING', from, {
                message: 'Account ' + from.account + ' (code "' + from.dischargeCodeRaw + '") expects a following ' +
                         from.transitionTo + ' account, but none exists within ' + maxGapMin + ' minutes' +
                         (requireSameDay ? ' on the same calendar date' : '') + '. No link was invented.'
              });
            }
            transitions.push(rec);
            continue;
          }

          if (candidates.length > 1) {
            /* Step 7: do not guess. */
            rec.confidence = LC.AMBIGUOUS;
            rec.issue = 'More than one account satisfies the expected transition.';
            var accts = [];
            for (var d = 0; d < candidates.length; d++) { accts.push(candidates[d].enc.account); }
            diag.addFor('DQ_TRANS_AMBIGUOUS', from, {
              message: 'Account ' + from.account + ' (code "' + from.dischargeCodeRaw + '") could link to ' +
                       candidates.length + ' accounts (' + accts.join(', ') + '). No link was made; the accounts stay in separate episodes until the data or rules are corrected.'
            });
            transitions.push(rec);
            continue;
          }

          /* Exactly one candidate: accept (steps 5 and 6). */
          var winner = candidates[0];
          var target = winner.enc;
          rec.toRowId = target.rowId;
          rec.toAccount = target.account;
          rec.toService = target.serviceClass;
          rec.toAdmit = target.admitDT;
          rec.gapMinutes = winner.gapMinutes;
          rec.sameDay = winner.sameDay;

          if (winner.gapMinutes < 0) {
            rec.confidence = LC.PROBABLE;
            rec.issue = 'The successor admits before the prior discharge, within the overlap tolerance.';
            diag.addFor('DQ_TRANS_OVERLAP', from, {
              message: 'Account ' + from.account + ' -> ' + target.account + ': the successor admits ' +
                       util.round(-winner.gapMinutes, 0) + ' minutes before the prior discharge, within the ' +
                       overlapTolMin + '-minute tolerance. Linked as Probable.'
            });
          } else {
            rec.confidence = LC.CONFIRMED;
            if (winner.gapMinutes > suspiciousMin) {
              rec.issue = 'Accepted, but the gap exceeds the suspicious-timing threshold.';
              diag.addFor('DQ_TRANS_GAP', from, {
                message: 'Account ' + from.account + ' -> ' + target.account + ': ' + util.round(winner.gapMinutes, 0) +
                         '-minute gap exceeds the ' + suspiciousMin + '-minute suspicious threshold, though it is inside the ' +
                         maxGapMin + '-minute maximum. Linked and flagged for verification.'
              });
            }
          }

          target.takenAsSuccessor = true;
          from.linkNext = { rowId: target.rowId, account: target.account, service: target.serviceClass, gapMinutes: winner.gapMinutes, confidence: rec.confidence };
          target.linkPrev = { rowId: from.rowId, account: from.account, service: from.serviceClass, gapMinutes: winner.gapMinutes, confidence: rec.confidence };

          if (!MODELED_PAIRS[from.serviceClass + '|' + target.serviceClass]) {
            diag.addFor('DQ_TRANS_UNMODELED', from, {
              message: 'Accounts ' + from.account + ' (' + from.serviceClass + ') -> ' + target.account +
                       ' (' + target.serviceClass + ') linked on discharge code "' + from.dischargeCodeRaw +
                       '", but no specific metric or review rule models a ' + from.serviceClass + ' -> ' +
                       target.serviceClass + ' change. The episode stays continuous and the link appears in the ' +
                       'Transitions worksheet, but it is counted in no named transition figure. Verify the discharge-code mapping for this pair.'
            });
          }
          transitions.push(rec);
        }

        /* ------------------------- step 9: possible uncoded service changes */
        for (var p = 0; p < list.length; p++) {
          var prev = list[p];
          if (prev.linkNext || !prev.dischargeDT || prev.transitionTo) { continue; }
          for (var q = 0; q < list.length; q++) {
            var next = list[q];
            if (next === prev || next.linkPrev || !next.admitDT) { continue; }
            if (next.serviceClass === prev.serviceClass) { continue; }
            var gap = (next.admitDT.getTime() - prev.dischargeDT.getTime()) / 60000;
            if (gap < 0 || gap > uncodedWindowMin) { continue; }
            if (util.dayIndex(next.admitDT) !== util.dayIndex(prev.dischargeDT)) { continue; }
            transitions.push({
              fromRowId: prev.rowId, toRowId: next.rowId,
              fromAccount: prev.account, toAccount: next.account,
              mrn: prev.mrn,
              fromService: prev.serviceClass, toService: next.serviceClass,
              expectedService: '', dischargeCode: prev.dischargeCodeRaw,
              fromDischarge: prev.dischargeDT, toAdmit: next.admitDT,
              gapMinutes: gap, sameDay: true,
              confidence: LC.UNLINKED,
              issue: 'Possible uncoded transition: a same-day service change with no transition discharge code. Not linked.',
              candidateAccounts: [next.account]
            });
            diag.addFor('DQ_TRANS_UNCODED', prev, {
              message: 'Account ' + prev.account + ' (' + prev.serviceClass + ', discharge code "' +
                       (prev.dischargeCodeRaw || 'none') + '") is followed ' + util.round(gap, 0) + ' minutes later by account ' +
                       next.account + ' (' + next.serviceClass + ') on the same date. No transition code is present, so no link was made on timing alone.'
            });
          }
        }

        /* ------------------- overlapping accounts not explained by a link */
        /* Pairs already reported by the specific refused-transition diagnostic
         * are not re-reported by the generic overlap scan. */
        var refusedPairs = {};
        for (var rp = 0; rp < transitions.length; rp++) {
          if (transitions[rp].confidence === LC.REFUSED && transitions[rp].toRowId) {
            refusedPairs[transitions[rp].fromRowId + '|' + transitions[rp].toRowId] = true;
            refusedPairs[transitions[rp].toRowId + '|' + transitions[rp].fromRowId] = true;
          }
        }
        for (var x = 0; x < list.length; x++) {
          for (var y = x + 1; y < list.length; y++) {
            var e1 = list[x], e2 = list[y];
            if (!e1.admitDT || !e2.admitDT) { continue; }
            var end1 = e1.dischargeDT, end2 = e2.dischargeDT;
            if (!end1 || !end2) { continue; }
            var overlap = util.overlapHours(e1.admitDT, end1, e2.admitDT, end2);
            if (overlap * 60 <= overlapTolMin) { continue; }
            var linked = (e1.linkNext && e1.linkNext.rowId === e2.rowId) || (e2.linkNext && e2.linkNext.rowId === e1.rowId);
            if (linked) { continue; }
            if (refusedPairs[e1.rowId + '|' + e2.rowId]) { continue; }
            diag.addFor('DQ_OVERLAP_UNEXPLAINED', e1, {
              message: 'Accounts ' + e1.account + ' (' + e1.serviceClass + ') and ' + e2.account + ' (' + e2.serviceClass +
                       ') for patient ' + e1.mrn + ' overlap by ' + util.round(overlap, 2) +
                       ' hours with no internal transition explaining it. Occupancy metrics may double-count this patient.'
            });
          }
        }
      }

      return { transitions: transitions };
    },

    /* Accepted links only (Confirmed or Probable). */
    acceptedTransitions: function (transitions) {
      var out = [];
      for (var i = 0; i < transitions.length; i++) {
        var t = transitions[i];
        if (t.confidence === LC.CONFIRMED || t.confidence === LC.PROBABLE) { out.push(t); }
      }
      return out;
    },

    /* Accepted links matching a from -> to service pair. */
    countPair: function (transitions, fromService, toService) {
      var n = 0;
      var acc = transitionLinker.acceptedTransitions(transitions);
      for (var i = 0; i < acc.length; i++) {
        if (acc[i].fromService === fromService && acc[i].toService === toService) { n++; }
      }
      return n;
    }
  };

  UR.transitionLinker = transitionLinker;

})(typeof globalThis !== 'undefined' ? globalThis : this);

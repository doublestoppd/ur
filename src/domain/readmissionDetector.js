/*
 * readmissionDetector.js - internal readmission indicators
 * (spec 9.7, rules READMIT_7_001 / READMIT_30_001 / READMIT_MCR_001).
 *
 * These are INTERNAL OPERATIONAL INDICATORS. They are not the CMS
 * risk-standardized readmission measures: there is no risk adjustment, no
 * planned-readmission algorithm, no condition cohort, and no visibility of
 * admissions at other facilities.
 *
 * Because the unit of analysis is the continuous EPISODE rather than the
 * service account, an internal OS -> IP or IP -> SB status change can never be
 * reported as a readmission (spec 16.1 item 6, fixture T09).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  function firstIPEncounter(episode) {
    for (var i = 0; i < episode.encounters.length; i++) {
      if (episode.encounters[i].serviceClass === UR.SERVICE.IP) { return episode.encounters[i]; }
    }
    return null;
  }

  var readmissionDetector = {

    /*
     * Returns { pairs, lookback } where each pair is one prior-episode /
     * new-episode relationship that fell inside the longest configured window:
     *
     *   { mrn, patientName, priorEpisodeId, priorFinalDischarge,
     *     priorDisposition, priorAccounts, newEpisodeId, newEpisodeStart,
     *     newIPAccount, newIPAdmit, payerCategory, daysBetween,
     *     within: { '7': bool, '30': bool }, isMedicare }
     */
    detect: function (episodes, config, diag) {
      var windows = config.thresholds.readmissionWindowDays.slice().sort(function (a, b) { return a - b; });
      var maxWindow = windows.length ? windows[windows.length - 1] : 30;

      var byMrn = util.groupBy(episodes, function (ep) { return ep.mrn; });
      var pairs = [];

      for (var g = 0; g < byMrn.keys.length; g++) {
        var mrn = byMrn.keys[g];
        if (!mrn) { continue; } /* records with no Patient ID cannot be linked */
        var list = byMrn.map[mrn].slice().sort(function (a, b) {
          return (a.startDT ? a.startDT.getTime() : 0) - (b.startDT ? b.startDT.getTime() : 0);
        });

        for (var i = 0; i < list.length; i++) {
          var next = list[i];
          if (!next.containsIP || !next.startDT) { continue; }

          /* Most recent earlier episode that contained acute inpatient care and
           * reached a final discharge. */
          var prior = null;
          for (var j = i - 1; j >= 0; j--) {
            var cand = list[j];
            if (!cand.containsIP || !cand.endDT) { continue; }
            if (cand.endDT.getTime() > next.startDT.getTime()) { continue; }
            prior = cand;
            break;
          }
          if (!prior) { continue; }

          var daysBetween = util.daysBetween(prior.endDT, next.startDT);
          if (daysBetween <= 0 || daysBetween > maxWindow) { continue; }

          var ipEnc = firstIPEncounter(next);
          var payer = ipEnc ? ipEnc.payerCategory : next.firstPayerCategory;
          var within = {};
          for (var w = 0; w < windows.length; w++) {
            within[String(windows[w])] = daysBetween > 0 && daysBetween <= windows[w];
          }

          pairs.push({
            mrn: mrn,
            patientName: next.patientName,
            priorEpisodeId: prior.episodeId,
            priorFinalDischarge: prior.endDT,
            priorDisposition: prior.finalDisposition || 'Unknown',
            priorDischargeCode: prior.finalDischargeCode,
            priorAccounts: prior.accounts.join(', '),
            newEpisodeId: next.episodeId,
            newEpisodeStart: next.startDT,
            newIPAccount: ipEnc ? ipEnc.account : '',
            newIPAdmit: ipEnc ? ipEnc.admitDT : next.startDT,
            payerCategory: payer,
            daysBetween: daysBetween,
            within: within,
            isMedicare: util.contains(UR.MEDICARE_CATEGORIES, payer)
          });
        }
      }

      /* --------------------------------------------- incomplete lookback */
      var earliest = null;
      for (var e = 0; e < episodes.length; e++) {
        var st = episodes[e].startDT;
        if (st && (!earliest || st.getTime() < earliest.getTime())) { earliest = st; }
      }
      var lookback = { earliestData: earliest, windowDays: maxWindow, affectedEpisodes: 0, cutoff: null };
      if (earliest) {
        var cutoff = util.addDays(earliest, maxWindow);
        lookback.cutoff = cutoff;
        for (var k = 0; k < episodes.length; k++) {
          var ep = episodes[k];
          if (ep.containsIP && ep.startDT && ep.startDT.getTime() < cutoff.getTime()) { lookback.affectedEpisodes++; }
        }
        if (lookback.affectedEpisodes && diag) {
          diag.add('DQ_LOOKBACK', {
            message: lookback.affectedEpisodes + ' acute inpatient episode(s) begin before ' + util.fmtDate(cutoff) +
                     ', within ' + maxWindow + ' days of the earliest imported admission (' + util.fmtDate(earliest) +
                     '). Any qualifying prior stay before that point is not in the data, so the readmission indicators understate the true count for that window. Import additional prior months to close the gap.'
          });
        }
      }

      return { pairs: pairs, lookback: lookback };
    },

    /* Pairs falling inside a specific window. */
    within: function (pairs, windowDays) {
      var out = [];
      var key = String(windowDays);
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].within[key]) { out.push(pairs[i]); }
      }
      return out;
    },

    /* Medicare FFS / MA subset of a window (READMIT_MCR_001). */
    medicareWithin: function (pairs, windowDays) {
      var out = [];
      var subset = readmissionDetector.within(pairs, windowDays);
      for (var i = 0; i < subset.length; i++) {
        if (subset[i].isMedicare) { out.push(subset[i]); }
      }
      return out;
    }
  };

  UR.readmissionDetector = readmissionDetector;

})(typeof globalThis !== 'undefined' ? globalThis : this);

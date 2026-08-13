/*
 * episodeBuilder.js - group linked accounts into continuous hospital episodes
 * (spec 8.1, 8.4, rule EPISODE_001).
 *
 * An episode is the unit that answers "how many times was this patient in the
 * hospital", as opposed to "how many service accounts did CPSI create". A
 * course of OS -> IP -> SB -> IP is four accounts and one episode; readmission
 * logic runs on episodes so an internal status change can never masquerade as a
 * readmission.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  function byStart(a, b) {
    var ta = a.startDT ? a.startDT.getTime() : 0;
    var tb = b.startDT ? b.startDT.getTime() : 0;
    if (ta !== tb) { return ta - tb; }
    return a.accounts[0] < b.accounts[0] ? -1 : (a.accounts[0] > b.accounts[0] ? 1 : 0);
  }

  var episodeBuilder = {

    /*
     * Returns { episodes, byId }. Each episode:
     *   { episodeId, mrn, encounters[], accounts[], serviceSequence[],
     *     startDT, endDT, isOpen, elapsedHours, elapsedDays,
     *     containsIP/OS/SB, acuteIPHours, finalDischargeCode,
     *     finalDisposition, isDeath, finalPayerCategory, accountCount,
     *     hasProbableLink }
     */
    buildEpisodes: function (encounters, diag) {
      var byRowId = {};
      var i;
      for (i = 0; i < encounters.length; i++) { byRowId[encounters[i].rowId] = encounters[i]; }

      var chains = [];
      var visited = {};

      /* Start from every head (no accepted predecessor) and walk forward. */
      for (i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible) { continue; }
        if (e.linkPrev && byRowId[e.linkPrev.rowId]) { continue; }
        if (visited[e.rowId]) { continue; }

        var chain = [];
        var cur = e;
        var guard = 0;
        while (cur && !visited[cur.rowId]) {
          visited[cur.rowId] = true;
          chain.push(cur);
          if (guard++ > 1000) { break; }
          cur = cur.linkNext ? byRowId[cur.linkNext.rowId] : null;
        }
        chains.push(chain);
      }

      /* Any record still unvisited sat inside a cycle created by contradictory
       * links. Emit it as its own episode rather than dropping it. */
      for (i = 0; i < encounters.length; i++) {
        var leftover = encounters[i];
        if (!leftover.metricEligible || visited[leftover.rowId]) { continue; }
        visited[leftover.rowId] = true;
        chains.push([leftover]);
        if (diag) {
          diag.addFor('DQ_TRANS_AMBIGUOUS', leftover, {
            message: 'Account ' + leftover.account + ' participates in a circular transition chain. It was placed in its own episode so it is neither lost nor double-counted.'
          });
        }
      }

      var episodes = [];
      for (var c = 0; c < chains.length; c++) {
        var chain2 = chains[c];
        var first = chain2[0];
        var last = chain2[chain2.length - 1];
        var accounts = [];
        var services = [];
        var acuteHours = 0;
        var containsIP = false, containsOS = false, containsSB = false;
        var hasProbable = false;
        var isOpen = false;

        for (var k = 0; k < chain2.length; k++) {
          var enc = chain2[k];
          accounts.push(enc.account);
          services.push(enc.serviceClass);
          if (enc.serviceClass === UR.SERVICE.IP) {
            containsIP = true;
            if (enc.durationHours !== null) { acuteHours += enc.durationHours; }
          }
          if (enc.serviceClass === UR.SERVICE.OS) { containsOS = true; }
          if (enc.serviceClass === UR.SERVICE.SB) { containsSB = true; }
          if (enc.linkNext && enc.linkNext.confidence === UR.LINK_CONFIDENCE.PROBABLE) { hasProbable = true; }
          if (enc.isOpen) { isOpen = true; }
        }

        var episode = {
          episodeId: '',
          mrn: first.mrn,
          patientName: first.name,
          encounters: chain2,
          accounts: accounts,
          serviceSequence: services,
          startDT: first.admitDT,
          endDT: last.isOpen ? null : last.dischargeDT,
          isOpen: isOpen || last.isOpen || !last.dischargeDT,
          elapsedHours: null,
          elapsedDays: null,
          containsIP: containsIP,
          containsOS: containsOS,
          containsSB: containsSB,
          acuteIPHours: containsIP ? acuteHours : null,
          accountCount: chain2.length,
          finalDischargeCode: last.dischargeCodeRaw,
          finalDisposition: last.dispositionCategory,
          /* True when the last account's discharge code expects an internal
           * successor: the episode ended in a status change (whose link failed
           * or whose successor is missing), not a true discharge. */
          endedInTransition: !!last.transitionTo,
          isDeath: !!last.isDeath,
          finalPayerCategory: last.payerCategory,
          firstPayerCategory: first.payerCategory,
          hasProbableLink: hasProbable
        };

        if (episode.startDT && episode.endDT) {
          episode.elapsedHours = util.hoursBetween(episode.startDT, episode.endDT);
          episode.elapsedDays = episode.elapsedHours / 24;
        }
        episodes.push(episode);
      }

      /* Deterministic numbering: chronological by start, then first account. */
      episodes.sort(byStart);
      var byId = {};
      for (var n = 0; n < episodes.length; n++) {
        var id = 'EP' + ('0000' + (n + 1)).slice(-5);
        episodes[n].episodeId = id;
        byId[id] = episodes[n];
        for (var m = 0; m < episodes[n].encounters.length; m++) {
          episodes[n].encounters[m].episodeId = id;
          episodes[n].encounters[m].episodeServiceSequence = episodes[n].serviceSequence.join(' -> ');
        }
      }

      return { episodes: episodes, byId: byId };
    },

    /* Episodes for one patient (derived Patient ID), chronological. */
    forMrn: function (episodes, mrn) {
      var out = [];
      for (var i = 0; i < episodes.length; i++) {
        if (episodes[i].mrn === mrn) { out.push(episodes[i]); }
      }
      out.sort(byStart);
      return out;
    }
  };

  UR.episodeBuilder = episodeBuilder;

})(typeof globalThis !== 'undefined' ? globalThis : this);

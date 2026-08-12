/*
 * observation.js - observation metrics (spec 9.3).
 *
 * Observation is measured in hours throughout, because the thresholds that
 * matter operationally and for Medicare notice screening are hourly (R3).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;
  var linker = UR.transitionLinker;
  var OS = UR.SERVICE.OS;
  var IP = UR.SERVICE.IP;

  var observation = {

    calculate: function (encounters, transitions, config, period) {
      var th = config.thresholds;
      var admitted = scope.admittedInPeriod(encounters, OS, period);
      var qualifying = scope.qualifyingDischarged(encounters, OS, config, period);
      var hours = scope.losHours(qualifying);
      var i, e;

      /*
       * Threshold cohorts: >24h, >36h, >48h by default. The registry defines
       * exactly these three rules, so all three keys are always produced even
       * if a configuration somehow carries a different number of thresholds -
       * a missing key would throw in the results view and the workbook rather
       * than degrading. Configuration validation refuses that shape up front;
       * this is the second line of defence.
       */
      var thresholdRuleIds = ['OS_24_001', 'OS_36_001', 'OS_48_001'];
      var cohorts = {};
      for (var t = 0; t < thresholdRuleIds.length; t++) {
        var limit = th.obsThresholdHours[t];
        var members = [];
        if (limit !== undefined && limit !== null) {
          for (i = 0; i < qualifying.length; i++) {
            if (qualifying[i].durationHours > limit) { members.push(qualifying[i]); }
          }
        }
        cohorts[thresholdRuleIds[t]] = {
          thresholdHours: limit === undefined ? null : limit,
          unavailable: limit === undefined || limit === null,
          value: members.length,
          percent: util.pct(members.length, qualifying.length),
          accounts: scope.accounts(members),
          encounters: members
        };
      }

      /* ------------------------------------------- OS -> IP conversions */
      var accepted = linker.acceptedTransitions(transitions);
      var byRowId = {};
      for (i = 0; i < encounters.length; i++) { byRowId[encounters[i].rowId] = encounters[i]; }

      var conversions = [];
      for (i = 0; i < accepted.length; i++) {
        var link = accepted[i];
        if (link.fromService !== OS || link.toService !== IP) { continue; }
        var osEnc = byRowId[link.fromRowId];
        var ipEnc = byRowId[link.toRowId];
        if (!osEnc || !scope.inPeriod(osEnc.admitDT, period)) { continue; }
        conversions.push({ link: link, os: osEnc, ip: ipEnc, osHours: osEnc.durationHours });
      }

      /*
       * Denominator (OSIP_RATE_001): observation accounts admitted in the period
       * whose outcome is knowable - excludes open and invalid records. Both the
       * denominator and what it excluded are reported.
       */
      var eligible = [];
      var excludedOpen = 0;
      var excludedInvalid = 0;
      for (i = 0; i < admitted.length; i++) {
        e = admitted[i];
        if (e.isOpen) { excludedOpen++; continue; }
        if (e.durationHours === null) { excludedInvalid++; continue; }
        eligible.push(e);
      }

      var conversionHours = [];
      for (i = 0; i < conversions.length; i++) {
        if (conversions[i].osHours !== null && conversions[i].osHours !== undefined) {
          conversionHours.push(conversions[i].osHours);
        }
      }

      var meanHours = util.mean(hours);
      var medianHours = util.median(hours);

      var result = {
        OS_ADM_001: {
          value: admitted.length,
          accounts: scope.accounts(admitted),
          encounters: admitted
        },
        OS_LOS_001: {
          n: qualifying.length,
          totalHours: util.sum(hours),
          encounters: qualifying,
          accounts: scope.accounts(qualifying)
        },
        OS_ALOS_001: {
          meanHours: meanHours,
          medianHours: medianHours,
          meanEquivalentDays: meanHours === null ? null : meanHours / 24,
          medianEquivalentDays: medianHours === null ? null : medianHours / 24,
          n: qualifying.length
        },
        OSIP_001: {
          value: conversions.length,
          detail: conversions,
          accounts: (function () {
            var out = [];
            for (var x = 0; x < conversions.length; x++) { out.push(conversions[x].os.account); }
            return out;
          })()
        },
        OSIP_RATE_001: {
          value: util.pct(conversions.length, eligible.length),
          numerator: conversions.length,
          denominator: eligible.length,
          excludedOpen: excludedOpen,
          excludedInvalid: excludedInvalid,
          denominatorNote: 'Observation accounts admitted in the period, excluding ' + excludedOpen +
                           ' open encounter(s) and ' + excludedInvalid + ' record(s) with unusable dates.'
        },
        OSIP_TIME_001: {
          meanHours: util.mean(conversionHours),
          medianHours: util.median(conversionHours),
          n: conversionHours.length
        },
        OS_24_PCT_001: {
          value: cohorts.OS_24_001.percent,
          numerator: cohorts.OS_24_001.value,
          denominator: qualifying.length
        },
        openAccounts: scope.openAccounts(encounters, OS)
      };

      for (var key in cohorts) {
        if (Object.prototype.hasOwnProperty.call(cohorts, key)) { result[key] = cohorts[key]; }
      }
      return result;
    }
  };

  UR.metrics = UR.metrics || {};
  UR.metrics.observation = observation;

})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * inpatient.js - acute inpatient metrics (spec 9.2).
 *
 * Every result carries the accounts behind it so the UI can offer "show
 * underlying rows" and the workbook can export the supporting list (spec 12.4).
 * Thresholds come from configuration; no bare numbers appear here (spec 15.3).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;
  var IP = UR.SERVICE.IP;

  var inpatient = {

    calculate: function (encounters, config, period) {
      var th = config.thresholds;
      var targetHours = th.acuteTargetHours;
      var targetDays = th.acuteTargetDays;

      var admitted = scope.admittedInPeriod(encounters, IP, period);
      var qualifying = scope.qualifyingDischarged(encounters, IP, config, period);
      var hours = scope.losHours(qualifying);

      var meanHours = util.mean(hours);
      var medianHours = util.median(hours);

      /* ------------------------------------------------------ long stays */
      var longStays = [];
      var excessTotalDays = 0;
      var i, e;
      for (i = 0; i < qualifying.length; i++) {
        e = qualifying[i];
        var excessDays = Math.max(e.durationHours - targetHours, 0) / 24;
        excessTotalDays += excessDays;
        if (e.durationHours > targetHours) {
          longStays.push({ encounter: e, excessDays: excessDays });
        }
      }
      var excessAmongLong = [];
      for (i = 0; i < longStays.length; i++) { excessAmongLong.push(longStays[i].excessDays); }

      /* --------------------------------------------------- one-day stays */
      var oneDay = [];
      for (i = 0; i < qualifying.length; i++) {
        e = qualifying[i];
        if (e.durationHours > 0 && e.durationHours <= th.oneDayStayHours) { oneDay.push(e); }
      }
      var oneDayByPayer = {};
      for (i = 0; i < oneDay.length; i++) {
        var pc = oneDay[i].payerCategory;
        oneDayByPayer[pc] = (oneDayByPayer[pc] || 0) + 1;
      }

      /* ------------------------ short Medicare / MA stays (< 2 midnights) */
      /*
       * The percent (IP_2MN_PCT_001) is out of Medicare/MA discharged accounts
       * whose midnight count is known - not out of all discharged IP - so the
       * denominator is computed and reported alongside the numerator.
       */
      var shortMedicare = [];
      var medicareQualifying = 0;
      for (i = 0; i < qualifying.length; i++) {
        e = qualifying[i];
        if (!util.contains(UR.MEDICARE_CATEGORIES, e.payerCategory)) { continue; }
        if (e.midnights === null) { continue; }
        medicareQualifying++;
        if (e.midnights < th.shortStayMidnights) { shortMedicare.push(e); }
      }

      /* ------------------------------------------------- LOS distribution */
      var bands = [];
      for (var b = 0; b < th.losBands.length; b++) {
        var band = th.losBands[b];
        var members = [];
        for (i = 0; i < qualifying.length; i++) {
          e = qualifying[i];
          var h = e.durationHours;
          var aboveMin = band.minHours === 0 ? h >= 0 : h > band.minHours;
          var belowMax = band.maxHours === null ? true : h <= band.maxHours;
          if (aboveMin && belowMax) { members.push(e); }
        }
        bands.push({
          label: band.label,
          count: members.length,
          percent: util.pct(members.length, qualifying.length),
          accounts: scope.accounts(members)
        });
      }

      var percentiles = [];
      for (var p = 0; p < th.losPercentiles.length; p++) {
        var q = th.losPercentiles[p];
        percentiles.push({
          label: 'P' + Math.round(q * 100),
          hours: util.percentile(hours, q),
          days: hours.length ? util.percentile(hours, q) / 24 : null
        });
      }

      var meanDays = meanHours === null ? null : meanHours / 24;

      return {
        IP_ADM_001: {
          value: admitted.length,
          accounts: scope.accounts(admitted),
          encounters: admitted
        },
        IP_LOS_001: {
          n: qualifying.length,
          totalHours: util.sum(hours),
          encounters: qualifying,
          accounts: scope.accounts(qualifying)
        },
        IP_ALOS_001: {
          hours: meanHours,
          days: meanDays,
          n: qualifying.length,
          accounts: scope.accounts(qualifying)
        },
        IP_MEDLOS_001: {
          hours: medianHours,
          days: medianHours === null ? null : medianHours / 24,
          n: qualifying.length
        },
        IP_TARGET_001: {
          meanDays: meanDays,
          targetDays: targetDays,
          varianceDays: meanDays === null ? null : meanDays - targetDays,
          varianceHours: meanDays === null ? null : (meanDays - targetDays) * 24,
          ratio: meanDays === null ? null : meanDays / targetDays,
          withinTarget: meanDays === null ? null : meanDays <= targetDays,
          n: qualifying.length
        },
        IP_GT4_001: {
          value: longStays.length,
          percent: util.pct(longStays.length, qualifying.length),
          denominator: qualifying.length,
          accounts: (function () {
            var out = [];
            for (var x = 0; x < longStays.length; x++) { out.push(longStays[x].encounter.account); }
            return out;
          })(),
          detail: longStays
        },
        IP_EXCESS_001: {
          totalDays: excessTotalDays,
          meanDaysAmongLongStays: util.mean(excessAmongLong),
          longStayCount: longStays.length
        },
        IP_SHORT_001: {
          value: oneDay.length,
          percent: util.pct(oneDay.length, qualifying.length),
          byPayer: oneDayByPayer,
          accounts: scope.accounts(oneDay),
          encounters: oneDay
        },
        IP_2MN_001: {
          value: shortMedicare.length,
          accounts: scope.accounts(shortMedicare),
          encounters: shortMedicare
        },
        IP_GT4_PCT_001: {
          value: util.pct(longStays.length, qualifying.length),
          numerator: longStays.length,
          denominator: qualifying.length
        },
        IP_1DAY_PCT_001: {
          value: util.pct(oneDay.length, qualifying.length),
          numerator: oneDay.length,
          denominator: qualifying.length
        },
        IP_2MN_PCT_001: {
          value: util.pct(shortMedicare.length, medicareQualifying),
          numerator: shortMedicare.length,
          denominator: medicareQualifying
        },
        LOSDIST_001: {
          bands: bands,
          percentiles: percentiles,
          n: qualifying.length
        },
        openAccounts: scope.openAccounts(encounters, IP)
      };
    }
  };

  UR.metrics = UR.metrics || {};
  UR.metrics.inpatient = inpatient;

})(typeof globalThis !== 'undefined' ? globalThis : this);

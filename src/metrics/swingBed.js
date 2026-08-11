/*
 * swingBed.js - swing-bed metrics and internal transition counts (spec 9.4).
 *
 * Swing-bed length of stay is kept strictly apart from acute inpatient LOS:
 * swing-bed days are excluded from the CAH 96-hour average (R1), so mixing them
 * would corrupt the one regulatory surveillance figure this tool produces.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;
  var linker = UR.transitionLinker;
  var IP = UR.SERVICE.IP;
  var OS = UR.SERVICE.OS;
  var SB = UR.SERVICE.SB;

  function pairDetail(transitions, fromService, toService, encounters, period) {
    var accepted = linker.acceptedTransitions(transitions);
    var byRowId = {};
    for (var i = 0; i < encounters.length; i++) { byRowId[encounters[i].rowId] = encounters[i]; }
    var out = [];
    for (var j = 0; j < accepted.length; j++) {
      var link = accepted[j];
      if (link.fromService !== fromService || link.toService !== toService) { continue; }
      var fromEnc = byRowId[link.fromRowId];
      if (!fromEnc || !scope.inPeriod(fromEnc.admitDT, period)) { continue; }
      out.push({ link: link, from: fromEnc, to: byRowId[link.toRowId] });
    }
    return out;
  }

  var swingBed = {

    calculate: function (encounters, transitions, config, period) {
      var admitted = scope.admittedInPeriod(encounters, SB, period);
      var qualifying = scope.qualifyingDischarged(encounters, SB, config, period);
      var hours = scope.losHours(qualifying);

      var ipsb = pairDetail(transitions, IP, SB, encounters, period);
      var ossb = pairDetail(transitions, OS, SB, encounters, period);
      var sbip = pairDetail(transitions, SB, IP, encounters, period);

      var meanHours = util.mean(hours);
      var medianHours = util.median(hours);

      return {
        SB_ADM_001: {
          value: admitted.length,
          accounts: scope.accounts(admitted),
          encounters: admitted
        },
        SB_LOS_001: {
          n: qualifying.length,
          totalHours: util.sum(hours),
          encounters: qualifying,
          accounts: scope.accounts(qualifying)
        },
        SB_ALOS_001: {
          meanHours: meanHours,
          meanDays: meanHours === null ? null : meanHours / 24,
          medianHours: medianHours,
          medianDays: medianHours === null ? null : medianHours / 24,
          n: qualifying.length
        },
        IPSB_001: { value: ipsb.length, detail: ipsb },
        OSSB_001: { value: ossb.length, detail: ossb },
        SBIP_001: { value: sbip.length, detail: sbip },
        openAccounts: scope.openAccounts(encounters, SB)
      };
    }
  };

  UR.metrics = UR.metrics || {};
  UR.metrics.swingBed = swingBed;

})(typeof globalThis !== 'undefined' ? globalThis : this);

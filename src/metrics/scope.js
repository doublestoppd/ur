/*
 * scope.js - reporting-period construction and the qualifying-record filters
 * every metric module shares.
 *
 * A reporting period is a wall-clock date range, inclusive of both endpoints,
 * held internally as [startDT, endExclusiveDT). `asOf` bounds open encounters
 * for occupancy purposes (spec 9.1).
 *
 * Which accounts "qualify" for a discharged-stay metric depends on
 * processing.losBasis. That choice is configuration, it is stated on every
 * affected rule in the Calculation Reference, and it is applied in exactly one
 * place: here.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  var scope = {

    /* Build a period from two wall-clock dates (times ignored). */
    makePeriod: function (startDate, endDate, asOf) {
      var start = util.startOfDay(startDate);
      var endExclusive = util.addDays(util.startOfDay(endDate), 1);
      var days = Math.round((endExclusive.getTime() - start.getTime()) / util.MS_PER_DAY);
      return {
        startDT: start,
        endDT: new Date(endExclusive.getTime() - 1),
        endExclusiveDT: endExclusive,
        days: days,
        asOf: asOf || endExclusive,
        label: util.fmtDate(start) + ' - ' + util.fmtDate(new Date(endExclusive.getTime() - 1))
      };
    },

    /* Full calendar month containing a datetime. */
    monthPeriod: function (dt) {
      var y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
      var start = util.mkDT(y, m, 1, 0, 0);
      var nextMonth = m === 12 ? util.mkDT(y + 1, 1, 1, 0, 0) : util.mkDT(y, m + 1, 1, 0, 0);
      return scope.makePeriod(start, new Date(nextMonth.getTime() - util.MS_PER_DAY), nextMonth);
    },

    /* Widest period covering all usable admission datetimes in the data. */
    inferPeriod: function (encounters) {
      var min = null, max = null;
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible || !e.admitDT) { continue; }
        if (!min || e.admitDT.getTime() < min.getTime()) { min = e.admitDT; }
        var end = e.dischargeDT || e.admitDT;
        if (!max || end.getTime() > max.getTime()) { max = end; }
      }
      if (!min) { return null; }
      return scope.makePeriod(min, max, max);
    },

    inPeriod: function (dt, period) {
      if (!dt) { return false; }
      var t = dt.getTime();
      return t >= period.startDT.getTime() && t < period.endExclusiveDT.getTime();
    },

    /* Accounts of one service class admitted within the period. */
    admittedInPeriod: function (encounters, serviceClass, period) {
      var out = [];
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible) { continue; }
        if (serviceClass && e.serviceClass !== serviceClass) { continue; }
        if (!scope.inPeriod(e.admitDT, period)) { continue; }
        out.push(e);
      }
      return out;
    },

    /* All included accounts admitted within the period, any service. */
    includedAdmittedInPeriod: function (encounters, period) {
      return scope.admittedInPeriod(encounters, null, period);
    },

    /*
     * Discharged accounts of one service class that qualify for LOS-based
     * metrics under the configured basis (spec 9.2 / 9.3 / 9.4).
     */
    qualifyingDischarged: function (encounters, serviceClass, config, period) {
      var basis = config.processing.losBasis;
      var out = [];
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible) { continue; }
        if (serviceClass && e.serviceClass !== serviceClass) { continue; }
        if (e.isOpen || e.durationHours === null) { continue; }
        var anchor = basis === 'admission' ? e.admitDT : e.dischargeDT;
        if (!scope.inPeriod(anchor, period)) { continue; }
        out.push(e);
      }
      return out;
    },

    /* Hours of a stay that fall inside the period; open stays stop at asOf. */
    inPeriodOccupancyHours: function (encounter, period, includeOpen) {
      if (!encounter.metricEligible || !encounter.admitDT) { return 0; }
      var end;
      if (encounter.isOpen || !encounter.dischargeDT) {
        if (!includeOpen) { return 0; }
        end = period.asOf;
      } else {
        end = encounter.dischargeDT;
      }
      if (end.getTime() <= encounter.admitDT.getTime()) { return 0; }
      return util.overlapHours(encounter.admitDT, end, period.startDT, period.endExclusiveDT);
    },

    /* Effective end of a stay for occupancy purposes, or null when unusable. */
    occupancyEnd: function (encounter, period, includeOpen) {
      if (encounter.isOpen || !encounter.dischargeDT) {
        return includeOpen ? period.asOf : null;
      }
      return encounter.dischargeDT;
    },

    /* LOS hours of a list of accounts. */
    losHours: function (encounters) {
      var out = [];
      for (var i = 0; i < encounters.length; i++) {
        if (encounters[i].durationHours !== null) { out.push(encounters[i].durationHours); }
      }
      return out;
    },

    /* Accounts that are open, i.e. still in house at export time. */
    openAccounts: function (encounters, serviceClass) {
      var out = [];
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible || !e.isOpen) { continue; }
        if (serviceClass && e.serviceClass !== serviceClass) { continue; }
        out.push(e);
      }
      return out;
    },

    accounts: function (encounters) {
      var out = [];
      for (var i = 0; i < encounters.length; i++) { out.push(encounters[i].account); }
      return out;
    }
  };

  UR.scope = scope;

})(typeof globalThis !== 'undefined' ? globalThis : this);

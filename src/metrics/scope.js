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

    /*
     * The full span of activity in the imported data: earliest admission to
     * latest discharge. This is a fact about the file, reported to the user -
     * it is NOT a good default reporting period (see inferReportingPeriod).
     */
    dataSpan: function (encounters) {
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

    /*
     * The calendar months a reporting period touches, in order, each clamped to
     * the period itself.
     *
     * Trend rows come from the PERIOD, never from "every month any record
     * touches": a swing-bed stay admitted two months earlier is context, not a
     * reporting month, and letting it create a column produces a gap-toothed
     * trend (Jun, then Aug) that a reader would take for a real sequence.
     */
    monthsIn: function (period) {
      var out = [];
      var cursor = util.mkDT(period.startDT.getUTCFullYear(), period.startDT.getUTCMonth() + 1, 1, 0, 0);
      var guard = 0;
      while (cursor.getTime() < period.endExclusiveDT.getTime() && guard++ < 600) {
        var whole = scope.monthPeriod(cursor);
        var start = whole.startDT.getTime() > period.startDT.getTime() ? whole.startDT : period.startDT;
        var endExclusive = whole.endExclusiveDT.getTime() < period.endExclusiveDT.getTime()
          ? whole.endExclusiveDT : period.endExclusiveDT;
        var end = new Date(endExclusive.getTime() - 1);
        out.push({
          key: util.monthKey(whole.startDT),
          label: util.monthLabel(util.monthKey(whole.startDT)),
          partial: start.getTime() !== whole.startDT.getTime() || endExclusive.getTime() !== whole.endExclusiveDT.getTime(),
          period: {
            startDT: start,
            endDT: end,
            endExclusiveDT: endExclusive,
            days: Math.round((endExclusive.getTime() - start.getTime()) / util.MS_PER_DAY),
            asOf: period.asOf.getTime() < endExclusive.getTime() ? period.asOf : endExclusive,
            label: util.fmtDate(start) + ' - ' + util.fmtDate(end)
          }
        });
        cursor = whole.endExclusiveDT;
      }
      return out;
    },

    /* Activity per calendar month: an admission and a discharge each count once. */
    monthActivity: function (encounters) {
      var counts = {};
      var keys = [];
      function bump(dt) {
        if (!dt) { return; }
        var k = util.monthKey(dt);
        if (counts[k] === undefined) { counts[k] = 0; keys.push(k); }
        counts[k]++;
      }
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible) { continue; }
        bump(e.admitDT);
        if (!e.isOpen) { bump(e.dischargeDT); }
      }
      keys.sort();
      return { counts: counts, keys: keys };
    },

    /* 'YYYY-MM' one month later. */
    nextMonthKey: function (key) {
      var parts = String(key).split('-');
      var y = Number(parts[0]);
      var m = Number(parts[1]);
      return m === 12 ? (y + 1) + '-01' : y + '-' + util.pad2(m + 1);
    },

    prevMonthKey: function (key) {
      var parts = String(key).split('-');
      var y = Number(parts[0]);
      var m = Number(parts[1]);
      return m === 1 ? (y - 1) + '-12' : y + '-' + util.pad2(m - 1);
    },

    /*
     * Default reporting period inferred from the data.
     *
     * The full data span is the wrong default. A swing-bed patient admitted in
     * June and discharged in August puts a June admission datetime in a file the
     * user thinks of as "August", and taking the earliest admission would then
     * report a one-month export as a quarter.
     *
     * So: count activity per calendar month, start from the busiest month, and
     * extend outwards only through adjacent months that carry at least
     * `processing.periodInferenceShare` of that peak. A handful of long stays
     * reaching back into an earlier month cannot drag the period with them,
     * while a genuine multi-month export keeps all of its months.
     *
     * Returns { period, keptMonths, droppedMonths, activity }. The user can
     * always override the result with the date controls.
     */
    inferReportingPeriod: function (encounters, config) {
      var activity = scope.monthActivity(encounters);
      if (!activity.keys.length) { return null; }

      var share = config && config.processing && typeof config.processing.periodInferenceShare === 'number'
        ? config.processing.periodInferenceShare : 0.2;

      var peakKey = activity.keys[0];
      var k, i;
      for (i = 1; i < activity.keys.length; i++) {
        k = activity.keys[i];
        if (activity.counts[k] > activity.counts[peakKey]) { peakKey = k; }
      }
      var floor = activity.counts[peakKey] * share;

      var kept = [peakKey];
      var cursor = scope.prevMonthKey(peakKey);
      while (activity.counts[cursor] !== undefined && activity.counts[cursor] >= floor) {
        kept.unshift(cursor);
        cursor = scope.prevMonthKey(cursor);
      }
      cursor = scope.nextMonthKey(peakKey);
      while (activity.counts[cursor] !== undefined && activity.counts[cursor] >= floor) {
        kept.push(cursor);
        cursor = scope.nextMonthKey(cursor);
      }

      var dropped = [];
      for (i = 0; i < activity.keys.length; i++) {
        if (!util.contains(kept, activity.keys[i])) { dropped.push(activity.keys[i]); }
      }

      var firstParts = kept[0].split('-');
      var lastParts = kept[kept.length - 1].split('-');
      var start = util.mkDT(Number(firstParts[0]), Number(firstParts[1]), 1, 0, 0);
      var lastMonth = scope.monthPeriod(util.mkDT(Number(lastParts[0]), Number(lastParts[1]), 1, 0, 0));

      return {
        period: scope.makePeriod(start, lastMonth.endDT, lastMonth.endExclusiveDT),
        keptMonths: kept,
        droppedMonths: dropped,
        activity: activity
      };
    },

    /*
     * True when any part of the stay falls inside the period. A stay admitted
     * before the period that discharges inside it - or is still open - is IN
     * SCOPE: partial overlap participates in patient counts, review lists,
     * and occupancy. Event metrics (admissions, discharges, transitions)
     * remain anchored on where the event itself falls.
     */
    overlapsPeriod: function (e, period) {
      if (!e.admitDT || !period) { return false; }
      var end = (e.isOpen || !e.dischargeDT) ? period.asOf : e.dischargeDT;
      if (!end) { end = period.endExclusiveDT; }
      return e.admitDT.getTime() < period.endExclusiveDT.getTime() &&
             end.getTime() > period.startDT.getTime();
    },

    /* Included accounts of one service class whose stay overlaps the period. */
    inScopeInPeriod: function (encounters, serviceClass, period) {
      var out = [];
      for (var i = 0; i < encounters.length; i++) {
        var e = encounters[i];
        if (!e.metricEligible) { continue; }
        if (serviceClass && e.serviceClass !== serviceClass) { continue; }
        if (!scope.overlapsPeriod(e, period)) { continue; }
        out.push(e);
      }
      return out;
    },

    /*
     * Where an accepted transition happened: the successor's admission moment,
     * falling back to the prior discharge. Used to attribute transition COUNTS
     * to a period, so a conversion inside the period is counted even when the
     * originating stay began before it.
     */
    transitionMoment: function (link) {
      return link.toAdmit || link.fromDischarge || null;
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

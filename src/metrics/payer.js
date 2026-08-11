/*
 * payer.js - mortality, disposition, payer mix, admission source, and day-of-week
 * summaries (spec 9.8).
 *
 * Payer figures are reported twice: by mapped payer category and by raw
 * insurance code. Aggregating only by category would hide a mapping mistake,
 * which is exactly the kind of silent error this tool is meant to prevent.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;

  function blankRow() {
    return {
      accounts: 0, ip: 0, os: 0, sb: 0,
      episodes: {}, episodeCount: 0,
      occupancyHours: 0, ipOccupancyHours: 0,
      equivalentPatientDays: 0,
      oneDayStays: 0, longStays: 0, obsOver24: 0, deaths: 0
    };
  }

  var payer = {

    calculate: function (encounters, episodes, config, period) {
      var includeOpen = !!config.processing.includeOpenInOccupancy;
      var th = config.thresholds;
      var included = scope.includedAdmittedInPeriod(encounters, period);
      var i, e, key;

      /* --------------------------------------------------------- mortality */
      var deaths = [];
      var deathsByService = {};
      var deathsByPayer = {};
      var dischargedInScope = [];
      for (i = 0; i < encounters.length; i++) {
        e = encounters[i];
        if (!e.metricEligible || e.isOpen || !e.dischargeDT) { continue; }
        if (!scope.inPeriod(e.dischargeDT, period)) { continue; }
        dischargedInScope.push(e);
        if (!e.isDeath) { continue; }
        deaths.push(e);
        deathsByService[e.serviceClass] = (deathsByService[e.serviceClass] || 0) + 1;
        deathsByPayer[e.payerCategory] = (deathsByPayer[e.payerCategory] || 0) + 1;
      }

      /* ------------------------------------------------------- disposition */
      var dispositionMap = {};
      var dispositionOrder = [];
      for (i = 0; i < dischargedInScope.length; i++) {
        e = dischargedInScope[i];
        key = e.dispositionCategory || 'Unknown';
        if (dispositionMap[key] === undefined) { dispositionMap[key] = { category: key, count: 0, accounts: [] }; dispositionOrder.push(key); }
        dispositionMap[key].count++;
        if (dispositionMap[key].accounts.length < 200) { dispositionMap[key].accounts.push(e.account); }
      }
      var dispositions = [];
      for (i = 0; i < dispositionOrder.length; i++) {
        var dr = dispositionMap[dispositionOrder[i]];
        dr.percent = util.pct(dr.count, dischargedInScope.length);
        dispositions.push(dr);
      }
      dispositions.sort(function (a, b) { return b.count - a.count; });

      /* --------------------------------------------------------- payer mix */
      var byCategory = {};
      var byRawCode = {};

      function bucket(store, k) {
        if (!store[k]) { store[k] = blankRow(); }
        return store[k];
      }

      for (i = 0; i < encounters.length; i++) {
        e = encounters[i];
        if (!e.metricEligible) { continue; }
        var admittedInPeriod = scope.inPeriod(e.admitDT, period);
        var occ = scope.inPeriodOccupancyHours(e, period, includeOpen);
        if (!admittedInPeriod && occ <= 0) { continue; }

        var cat = bucket(byCategory, e.payerCategory || UR.PAYER_CATEGORY.UNKNOWN);
        var raw = bucket(byRawCode, e.insuranceRaw === '' ? '(blank)' : e.insuranceRaw);
        var targets = [cat, raw];

        for (var t = 0; t < targets.length; t++) {
          var row = targets[t];
          if (admittedInPeriod) {
            row.accounts++;
            if (e.serviceClass === UR.SERVICE.IP) { row.ip++; }
            if (e.serviceClass === UR.SERVICE.OS) { row.os++; }
            if (e.serviceClass === UR.SERVICE.SB) { row.sb++; }
            if (e.episodeId && !row.episodes[e.episodeId]) { row.episodes[e.episodeId] = true; row.episodeCount++; }
          }
          row.occupancyHours += occ;
          if (e.serviceClass === UR.SERVICE.IP) { row.ipOccupancyHours += occ; }
          row.equivalentPatientDays = row.occupancyHours / 24;
        }

        /* Review-sensitive counts use the discharged-stay qualifying basis. */
        var qualifies = !e.isOpen && e.durationHours !== null &&
          scope.inPeriod(config.processing.losBasis === 'admission' ? e.admitDT : e.dischargeDT, period);
        if (qualifies) {
          for (var u = 0; u < targets.length; u++) {
            var r2 = targets[u];
            if (e.serviceClass === UR.SERVICE.IP) {
              if (e.durationHours > 0 && e.durationHours <= th.oneDayStayHours) { r2.oneDayStays++; }
              if (e.durationHours > th.acuteTargetHours) { r2.longStays++; }
            }
            if (e.serviceClass === UR.SERVICE.OS && e.durationHours > th.obsThresholdHours[0]) { r2.obsOver24++; }
            if (e.isDeath) { r2.deaths++; }
          }
        }
      }

      function toRows(store, labelKey) {
        var rows = [];
        for (var k in store) {
          if (!Object.prototype.hasOwnProperty.call(store, k)) { continue; }
          var row = store[k];
          rows.push({
            key: k,
            label: labelKey === 'raw' ? k : k,
            accounts: row.accounts, ip: row.ip, os: row.os, sb: row.sb,
            episodeCount: row.episodeCount,
            occupancyHours: row.occupancyHours,
            ipOccupancyHours: row.ipOccupancyHours,
            equivalentPatientDays: row.occupancyHours / 24,
            oneDayStays: row.oneDayStays, longStays: row.longStays,
            obsOver24: row.obsOver24, deaths: row.deaths
          });
        }
        rows.sort(function (a, b) { return b.accounts - a.accounts || (a.key < b.key ? -1 : 1); });
        return rows;
      }

      var categoryRows = toRows(byCategory, 'category');
      var rawRows = toRows(byRawCode, 'raw');
      var totalAccounts = 0;
      for (i = 0; i < categoryRows.length; i++) { totalAccounts += categoryRows[i].accounts; }
      for (i = 0; i < categoryRows.length; i++) {
        categoryRows[i].percentOfAccounts = util.pct(categoryRows[i].accounts, totalAccounts);
      }

      /* --------------------------------------------------- admission source */
      var srcMap = {};
      var srcOrder = [];
      var hasSourceColumn = false;
      for (i = 0; i < included.length; i++) {
        e = included[i];
        if (e.admissionSourceRaw !== '') { hasSourceColumn = true; }
        key = e.admissionSourceRaw === '' ? '(blank)' : e.admissionSourceRaw;
        if (!srcMap[key]) {
          srcMap[key] = { code: key, label: e.admissionSourceLabel || '', category: e.admissionSourceCategory || '', count: 0 };
          srcOrder.push(key);
        }
        srcMap[key].count++;
        if (!srcMap[key].label && e.admissionSourceLabel) { srcMap[key].label = e.admissionSourceLabel; }
      }
      var sources = [];
      for (i = 0; i < srcOrder.length; i++) {
        var sr = srcMap[srcOrder[i]];
        sr.percent = util.pct(sr.count, included.length);
        sources.push(sr);
      }
      sources.sort(function (a, b) { return b.count - a.count; });

      /* --------------------------------------------------------- day of week */
      var admitsByDow = [0, 0, 0, 0, 0, 0, 0];
      var dischargesByDow = [0, 0, 0, 0, 0, 0, 0];
      for (i = 0; i < encounters.length; i++) {
        e = encounters[i];
        if (!e.metricEligible) { continue; }
        if (e.admitDT && scope.inPeriod(e.admitDT, period)) { admitsByDow[util.dayOfWeek(e.admitDT)]++; }
        if (e.dischargeDT && !e.isOpen && scope.inPeriod(e.dischargeDT, period)) { dischargesByDow[util.dayOfWeek(e.dischargeDT)]++; }
      }

      return {
        DEATH_001: {
          value: deaths.length,
          percent: util.pct(deaths.length, dischargedInScope.length),
          denominator: dischargedInScope.length,
          byService: deathsByService,
          byPayer: deathsByPayer,
          accounts: scope.accounts(deaths),
          encounters: deaths
        },
        DISPO_001: {
          rows: dispositions,
          denominator: dischargedInScope.length
        },
        PAYER_MIX_001: {
          byCategory: categoryRows,
          byRawCode: rawRows,
          totalAccounts: totalAccounts
        },
        ADMSRC_001: {
          available: hasSourceColumn,
          rows: sources,
          denominator: included.length
        },
        DOW_001: {
          admits: admitsByDow,
          discharges: dischargesByDow,
          dayNames: util.DAY_NAMES
        }
      };
    }
  };

  UR.metrics = UR.metrics || {};
  UR.metrics.payer = payer;

})(typeof globalThis !== 'undefined' ? globalThis : this);

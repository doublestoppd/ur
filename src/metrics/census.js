/*
 * census.js - patient days, average daily census, and the admission /
 * episode / patient counts (spec 9.5, 9.6).
 *
 * TWO PATIENT-DAY METHODS ARE CALCULATED ON PURPOSE. The inherited workbook's
 * definition is uncertain and patient-day conventions differ, so the tool
 * reports both a time-weighted method and a midnight-census method and lets the
 * hospital validate which one matches its official reporting. Neither is
 * labelled "the" patient-day figure (spec 9.5).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;
  var scope = UR.scope;
  var SERVICES = UR.INCLUDED_SERVICES;

  function emptyByService(initial) {
    var o = { total: initial };
    for (var i = 0; i < SERVICES.length; i++) { o[SERVICES[i]] = initial; }
    return o;
  }

  var census = {

    calculate: function (encounters, episodes, config, period) {
      var includeOpen = !!config.processing.includeOpenInOccupancy;
      var i, e, s;

      /* ------------------------------- PD_EQ_001: time-weighted occupancy */
      var occupancyHours = emptyByService(0);
      var openContributors = 0;
      for (i = 0; i < encounters.length; i++) {
        e = encounters[i];
        if (!e.metricEligible) { continue; }
        var h = scope.inPeriodOccupancyHours(e, period, includeOpen);
        if (h <= 0) { continue; }
        occupancyHours.total += h;
        if (occupancyHours[e.serviceClass] !== undefined) { occupancyHours[e.serviceClass] += h; }
        if (e.isOpen) { openContributors++; }
      }

      var equivalentDays = emptyByService(0);
      equivalentDays.total = occupancyHours.total / 24;
      for (s = 0; s < SERVICES.length; s++) {
        equivalentDays[SERVICES[s]] = occupancyHours[SERVICES[s]] / 24;
      }

      /* ------------------------------- PD_MN_001: midnight census method */
      var midnightDays = emptyByService(0);
      var dailyCensus = [];
      for (var d = 0; d < period.days; d++) {
        var midnight = util.addDays(period.startDT, d);
        var mt = midnight.getTime();
        var day = { date: midnight, total: 0 };
        for (s = 0; s < SERVICES.length; s++) { day[SERVICES[s]] = 0; }

        for (i = 0; i < encounters.length; i++) {
          e = encounters[i];
          if (!e.metricEligible || !e.admitDT) { continue; }
          var end = scope.occupancyEnd(e, period, includeOpen);
          if (!end) { continue; }
          if (e.admitDT.getTime() <= mt && mt < end.getTime()) {
            day.total++;
            if (day[e.serviceClass] !== undefined) { day[e.serviceClass]++; }
          }
        }
        midnightDays.total += day.total;
        for (s = 0; s < SERVICES.length; s++) { midnightDays[SERVICES[s]] += day[SERVICES[s]]; }
        dailyCensus.push(day);
      }

      /* ------------------------------------------- admissions / episodes */
      var ipAdm = scope.admittedInPeriod(encounters, UR.SERVICE.IP, period).length;
      var osAdm = scope.admittedInPeriod(encounters, UR.SERVICE.OS, period).length;
      var sbAdm = scope.admittedInPeriod(encounters, UR.SERVICE.SB, period).length;

      var episodesInPeriod = [];
      for (i = 0; i < episodes.length; i++) {
        if (scope.inPeriod(episodes[i].startDT, period)) { episodesInPeriod.push(episodes[i]); }
      }

      /* Unique patients: anyone IN SCOPE during the period, including stays
       * that only partly overlap it (admitted before, discharged inside). */
      var included = scope.inScopeInPeriod(encounters, null, period);
      var mrns = {};
      var missingMrn = 0;
      for (i = 0; i < included.length; i++) {
        if (!included[i].mrn) { missingMrn++; continue; }
        mrns[included[i].mrn] = true;
      }
      var uniquePatients = 0;
      for (var k in mrns) { if (Object.prototype.hasOwnProperty.call(mrns, k)) { uniquePatients++; } }

      var adcEq = period.days ? occupancyHours.total / (24 * period.days) : null;
      var adcMn = period.days ? midnightDays.total / period.days : null;

      return {
        PD_EQ_001: {
          value: equivalentDays.total,
          byService: equivalentDays,
          occupancyHours: occupancyHours,
          openEncountersIncluded: includeOpen ? openContributors : 0,
          asOf: period.asOf
        },
        PD_MN_001: {
          value: midnightDays.total,
          byService: midnightDays,
          dailyCensus: dailyCensus
        },
        PD_IP_001: { midnightDays: midnightDays.IP, equivalentDays: equivalentDays.IP, service: UR.SERVICE.IP },
        PD_OS_001: { midnightDays: midnightDays.OS, equivalentDays: equivalentDays.OS, service: UR.SERVICE.OS },
        PD_SB_001: { midnightDays: midnightDays.SB, equivalentDays: equivalentDays.SB, service: UR.SERVICE.SB },
        ADC_EQ_001: {
          value: adcEq,
          days: period.days
        },
        ADC_MN_001: {
          value: adcMn,
          days: period.days
        },
        ADM_SVC_001: {
          value: ipAdm + osAdm + sbAdm,
          ip: ipAdm, os: osAdm, sb: sbAdm,
          note: 'Service-account count. Includes internal status transitions; compare with the continuous-episode count.'
        },
        EPISODE_CNT_001: {
          value: episodesInPeriod.length,
          episodes: episodesInPeriod
        },
        PATIENT_CNT_001: {
          value: uniquePatients,
          missingMrnRecords: missingMrn
        },
        /*
         * Respite-care rows (service code RP) are deliberately excluded from
         * every utilization figure; this count exists so their presence in
         * the upload is visible rather than silently absorbed. Counted over
         * everything uploaded, not period-filtered.
         */
        RESPITE_001: (function () {
          var rows = [];
          for (var r = 0; r < encounters.length; r++) {
            var raw = String(encounters[r].serviceRaw || '').trim().toUpperCase();
            if (raw === 'RP') { rows.push(encounters[r]); }
          }
          return {
            value: rows.length,
            accounts: scope.accounts(rows)
          };
        })()
      };
    }
  };

  UR.metrics = UR.metrics || {};
  UR.metrics.census = census;

})(typeof globalThis !== 'undefined' ? globalThis : this);

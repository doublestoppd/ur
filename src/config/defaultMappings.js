/*
 * defaultMappings.js - built-in reference data and operational thresholds
 * (spec 7.2, Appendix A).
 *
 * Everything in this file is EDITABLE THROUGH THE UI and persisted in the
 * configuration JSON. Nothing here is a calculation formula; formulas live in
 * calculationRules.js and the metric modules. Keeping the two apart is what
 * lets the UI say honestly which knobs a user may turn (spec 7).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var SERVICE = UR.SERVICE;
  var PC = UR.PAYER_CATEGORY;

  /* ---------------------------------------------------------- service codes */
  /* behavior: one of SERVICE.IP / OS / SB / IGNORED (spec 7.1, A.1). */
  var SERVICE_CODES = [
    { code: 'IP', label: 'Acute inpatient', behavior: SERVICE.IP, enabled: true },
    { code: 'OS', label: 'Observation', behavior: SERVICE.OS, enabled: true },
    { code: 'SB', label: 'Swing bed', behavior: SERVICE.SB, enabled: true }
  ];

  /* ------------------------------------------------------- discharge codes */
  /*
   * transitionTo names the service the NEXT account is expected to carry when
   * this discharge code implies an internal status change (spec 8.2).
   * transitionFrom, when present, restricts the rule to a source service - code
   * V only means SB -> IP when the discharging account is a swing-bed account.
   */
  var DISCHARGE_CODES = [
    {
      code: 'B', label: 'Admitted OS to IP', category: 'Internal transition',
      transitionTo: SERVICE.IP, transitionFrom: [SERVICE.OS], enabled: true,
      note: 'Observation admitted/converted to inpatient. Expect a following IP account.'
    },
    {
      code: 'Q', label: 'Discharge to swing bed', category: 'Internal transition',
      transitionTo: SERVICE.SB, transitionFrom: [SERVICE.IP, SERVICE.OS], enabled: true,
      note: 'Expect a following SB account.'
    },
    {
      code: 'V', label: 'Transfer to Critical Access Hospital (locally used for SB to IP)',
      category: 'Internal transition', transitionTo: SERVICE.IP, transitionFrom: [SERVICE.SB],
      enabled: true,
      note: 'HOSPITAL-SPECIFIC. The published meaning of V is transfer to a CAH. This hospital ' +
            'also uses V when a swing-bed patient returns to acute inpatient status, so V is ' +
            'treated as SB -> IP only when the discharging account is a swing-bed account.'
    },
    { code: 'H', label: 'Home', category: 'Discharged home', transitionTo: null, enabled: true, note: 'True discharge.' },
    { code: 'P', label: 'Hospice / SNF', category: 'Hospice or SNF', transitionTo: null, enabled: true, note: 'True discharge. Raw hospital description preserved.' },
    { code: 'X', label: 'Transfer to another facility for inpatient care', category: 'External transfer', transitionTo: null, enabled: true, note: 'External inpatient transfer.' },
    { code: 'I', label: 'Transfer to intermediate care', category: 'External transfer', transitionTo: null, enabled: true, note: 'External / intermediate care transfer.' },
    { code: 'E', label: 'Patient died', category: 'Death', transitionTo: null, enabled: true, note: 'Mortality source signal (spec 9.8).' },
    { code: 'A', label: 'Transfer to home health', category: 'Discharged home with services', transitionTo: null, enabled: true, note: 'Home with home health.' },
    { code: 'K', label: 'Transfer to Veterans Administration hospital', category: 'External transfer', transitionTo: null, enabled: true, note: 'External transfer: VA hospital.' },
    { code: 'N', label: 'Discharge to skilled nursing facility', category: 'SNF', transitionTo: null, enabled: true, note: 'External SNF discharge.' }
  ];

  /* Discharge-code category treated as death by DEATH_001. */
  var DEATH_CATEGORY = 'Death';

  /*
   * Insurance and admission-source codes: no defaults were supplied by the
   * hospital (spec A.3). Both tables start empty; every encountered value is
   * inventoried and held in the Unknown category until a user maps it.
   */
  var INSURANCE_CODES = [];
  var ADMISSION_SOURCES = [];

  /* --------------------------------------------------- operational settings */
  var TRANSITION_SETTINGS = {
    /* Maximum positive gap, in minutes, between a discharge and the successor
     * admission for an automatic link (spec 7.2). */
    maxGapMinutes: 120,
    /* A successor that starts slightly BEFORE the prior discharge links only as
     * "probable" and always raises a warning (spec 7.2, 8.3 step 6). */
    overlapToleranceMinutes: 15,
    /* Require the successor admission to fall on the same wall-clock calendar
     * date as the prior discharge (spec 7.2). */
    requireSameCalendarDate: true,
    /* Gap beyond which a link that is still inside maxGapMinutes is called out
     * as suspicious timing (spec 11.2). */
    suspiciousGapMinutes: 60,
    /* Window used to detect a same-day service change that carries no
     * transition discharge code (spec 8.3 step 9). Detection only - never an
     * automatic link. */
    uncodedTransitionWindowMinutes: 120
  };

  var REVIEW_THRESHOLDS = {
    acuteTargetHours: 96,        /* CAH 96-hour / 4-day operational target (R1, R2) */
    acuteTargetDays: 4,
    obsThresholdHours: [24, 36, 48],
    oneDayStayHours: 24,         /* IP_SHORT_001 / RQ_1DAY upper bound */
    shortStayMidnights: 2,       /* IP_2MN_001: fewer than 2 midnights (R5) */
    moonThresholdHours: 24,      /* MOON manual-check candidate threshold (R3) */
    readmissionWindowDays: [7, 30],
    losBands: [
      { label: '<= 1 day', minHours: 0, maxHours: 24 },
      { label: '> 1 - 2 days', minHours: 24, maxHours: 48 },
      { label: '> 2 - 4 days', minHours: 48, maxHours: 96 },
      { label: '> 4 days', minHours: 96, maxHours: null }
    ],
    losPercentiles: [0.5, 0.75, 0.9]
  };

  var PROCESSING_SETTINGS = {
    /*
     * Which datetime places a discharged stay in the reporting period for
     * LOS/ALOS purposes. 'discharge' follows the usual hospital convention
     * (a stay is measured in the month it completes); 'admission' matches the
     * admission-count basis. Surfaced in the Calculation Reference so the
     * choice is never invisible (spec 9.2 ambiguity).
     */
    losBasis: 'discharge',
    /* Include open encounters in occupancy/census through asOfDateTime
     * (spec 9.1). They are always excluded from discharged-stay ALOS. */
    includeOpenInOccupancy: true,
    /* Omit patient names from exported detail/review sheets (spec 4.3). */
    excludePatientNames: false,
    /* Duplicate account numbers with identical content are collapsed; conflicting
     * duplicates are never merged silently (spec 6.3, T17). */
    deduplicateIdenticalRows: true
  };

  UR.defaultMappings = {
    SERVICE_CODES: SERVICE_CODES,
    DISCHARGE_CODES: DISCHARGE_CODES,
    DEATH_CATEGORY: DEATH_CATEGORY,
    INSURANCE_CODES: INSURANCE_CODES,
    ADMISSION_SOURCES: ADMISSION_SOURCES,
    TRANSITION_SETTINGS: TRANSITION_SETTINGS,
    REVIEW_THRESHOLDS: REVIEW_THRESHOLDS,
    PROCESSING_SETTINGS: PROCESSING_SETTINGS,
    PAYER_CATEGORIES: UR.PAYER_CATEGORY_LIST,
    DISCHARGE_CATEGORIES: [
      'Internal transition', 'Discharged home', 'Discharged home with services',
      'SNF', 'Hospice or SNF', 'External transfer', 'Death', 'Other', 'Unknown'
    ],

    /* A fresh, fully populated configuration object. */
    build: function () {
      return {
        configVersion: 1,
        schemaVersion: UR.CONFIG_SCHEMA_VERSION,
        rulesetVersion: UR.RULESET_VERSION,
        serviceCodes: UR.util.clone(SERVICE_CODES),
        dischargeCodes: UR.util.clone(DISCHARGE_CODES),
        insuranceCodes: UR.util.clone(INSURANCE_CODES),
        admissionSources: UR.util.clone(ADMISSION_SOURCES),
        transition: UR.util.clone(TRANSITION_SETTINGS),
        thresholds: UR.util.clone(REVIEW_THRESHOLDS),
        processing: UR.util.clone(PROCESSING_SETTINGS),
        deathCategory: DEATH_CATEGORY
      };
    }
  };

  /* Placeholder mapping row created for a code the tool has never seen. */
  UR.defaultMappings.blankInsurance = function (code) {
    return { code: code, label: '', category: PC.UNKNOWN, enabled: true };
  };

  UR.defaultMappings.blankAdmissionSource = function (code) {
    return { code: code, label: '', category: '', enabled: true };
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

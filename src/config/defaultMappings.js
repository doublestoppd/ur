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
   * The hospital's complete discharge-code table. The description keeps the
   * UB-04 patient discharge status number the hospital carries with each code
   * ("01 DISCHARGE TO HOME"), because that number is what a biller or auditor
   * will look for.
   *
   * transitionTo names the service the NEXT account is expected to carry when a
   * code implies an internal status change (spec 8.2). transitionFrom, where
   * present, restricts the rule to a source service - V only means SB -> IP
   * when the discharging account is a swing-bed account.
   */
  var DISCHARGE_CODES = [
    /* ---------------------------------------------- internal status changes */
    {
      code: 'B', label: '09 ADMITTED OP TO IP', category: 'Internal transition',
      transitionTo: SERVICE.IP, transitionFrom: [SERVICE.OS], enabled: true,
      note: 'Outpatient (observation) converted to inpatient. Expect a following IP account. ' +
            'Restricted to observation source accounts because other outpatient services are not included in the metrics.'
    },
    {
      code: 'Q', label: '61 DIS/TRANS TO SWING BED', category: 'Internal transition',
      transitionTo: SERVICE.SB, transitionFrom: [SERVICE.IP, SERVICE.OS], enabled: true,
      note: 'Expect a following SB account.'
    },
    {
      code: 'V', label: '66 DIS/TRANS TO A CRITICAL ACCESS HOSPITAL (CAH)',
      category: 'Internal transition', transitionTo: SERVICE.IP, transitionFrom: [SERVICE.SB],
      enabled: true,
      note: 'HOSPITAL-SPECIFIC. The published meaning of 66 is transfer to another Critical Access Hospital. ' +
            'This hospital also uses V when a swing-bed patient returns to acute inpatient status, so V is read ' +
            'as SB -> IP only when the discharging account is a swing-bed account. A genuine outward transfer ' +
            'to another CAH will be reported as a missing expected successor.'
    },
    {
      code: 'Z', label: '10 ADMIT TO OBSERVATION', category: 'Internal transition',
      transitionTo: SERVICE.OS, transitionFrom: null, enabled: true,
      note: 'Expect a following observation account. Linking the accounts keeps the episode continuous; it makes ' +
            'no Condition Code 44 determination, which this tool does not attempt. Disable this row if the hospital ' +
            'does not use Z as an internal status change.'
    },

    /* ------------------------------------------------------ true discharges */
    { code: 'H', label: '01 DISCHARGE TO HOME', category: 'Discharged home', transitionTo: null, enabled: true, note: '' },
    { code: 'A', label: '06 DIS/TRANS TO HOME HEALTH', category: 'Home with services', transitionTo: null, enabled: true, note: '' },
    { code: 'L', label: '07 LEFT AGAINST MEDICAL ADVICE / DISCONTINUED CARE', category: 'Left against medical advice', transitionTo: null, enabled: true, note: 'Worth watching alongside readmissions.' },
    { code: 'M', label: '50 HOSPICE - HOME', category: 'Hospice', transitionTo: null, enabled: true, note: '' },
    { code: 'P', label: '51 DIS/TRANS TO HOSPICE OR SNF', category: 'Hospice', transitionTo: null, enabled: true, note: 'The hospital list combines hospice and SNF under this code; split it if the two need to be reported separately.' },
    { code: 'N', label: '03 DIS/TRAN TO SKILLED NURSING FACILITY (SNF)', category: 'Skilled nursing facility', transitionTo: null, enabled: true, note: '' },
    { code: 'I', label: '04 DIS/TRANS TO INTERMEDIATE CARE FACILITY (ICF)', category: 'Intermediate care', transitionTo: null, enabled: true, note: '' },

    /* ---------------------------------------------------- outward transfers */
    { code: 'X', label: '02 DIS/TRANS TO ACUTE CARE HOSP FOR IP CARE', category: 'Acute care transfer', transitionTo: null, enabled: true, note: '' },
    { code: 'O', label: "05 DIS/TRANS TO CANCER CENTER/ CHILDREN'S HOSPITAL", category: 'Acute care transfer', transitionTo: null, enabled: true, note: '' },
    { code: 'R', label: '62 DIS/TRANS TO IP REHAB FACILITY (IRF)', category: 'Rehabilitation facility', transitionTo: null, enabled: true, note: '' },
    { code: 'S', label: '63 DIS/TRANS TO LONG TERM CARE HOSP (LTCH)', category: 'Long-term care hospital', transitionTo: null, enabled: true, note: '' },
    { code: 'T', label: '64 DIS/TRANS TO CERTIFIED MEDICAID LTCH NOT MEDICARE', category: 'Long-term care hospital', transitionTo: null, enabled: true, note: '' },
    { code: 'U', label: '65 DIS/TRANS TO PSYCHIATRIC HOSPITAL', category: 'Psychiatric hospital', transitionTo: null, enabled: true, note: '' },
    { code: 'K', label: "43 DIS/TRANS DEPT DEF HOSPITAL OR VETERAN'S ADMINISTRAT", category: 'Federal or VA hospital', transitionTo: null, enabled: true, note: '' },
    { code: 'C', label: '21 DIS/TRANS TO COURT/LAW ENFORCEMENT', category: 'Court or law enforcement', transitionTo: null, enabled: true, note: '' },

    /* ---------------------------------------------------------------- deaths */
    { code: 'E', label: '20 EXPIRED', category: 'Death', transitionTo: null, enabled: true, note: '' },
    { code: 'F', label: '40 EXPIRED AT HOME', category: 'Death', transitionTo: null, enabled: true, note: '' },
    { code: 'G', label: '41 EXPIRED IN A MEDICAL FACILITY', category: 'Death', transitionTo: null, enabled: true, note: '' },
    { code: 'J', label: '42 EXPIRED - PLACE UNKNOWN', category: 'Death', transitionTo: null, enabled: true, note: '' }
  ];

  /* Discharge-code category treated as death by DEATH_001. */
  var DEATH_CATEGORY = 'Death';

  /*
   * The hospital's origin (admission source) codes, exported in the
   * `origin_code` column.
   *
   * Note that OBSERVATION is listed as "6" rather than "06". A spreadsheet
   * column of these values may arrive as text ("06") or as numbers (6), so code
   * lookup falls back to a numeric comparison when no exact match exists and
   * reports when it does (util.findByCode).
   */
  var ADMISSION_SOURCES = [
    { code: '01', label: 'HOME', category: 'Community', enabled: true },
    { code: '02', label: 'CLINIC REFERRAL', category: 'Referral', enabled: true },
    { code: '03', label: 'OTHER HEALTHCARE FAC', category: 'Transfer', enabled: true },
    { code: '04', label: 'EMERGENCY ROOM', category: 'Emergency', enabled: true },
    { code: '05', label: 'LAW ENFORCEMENT', category: 'Law enforcement', enabled: true },
    { code: '6', label: 'OBSERVATION', category: 'Internal status change', enabled: true },
    { code: '07', label: 'SWING BED', category: 'Internal status change', enabled: true }
  ];

  /* The hospital insurance table lives in its own file: 736 codes. */
  var INSURANCE_CODES = UR.hospitalInsuranceCodes || [];

  /* --------------------------------------------------- operational settings */
  var TRANSITION_SETTINGS = {
    /* Maximum positive gap, in minutes, between a discharge and the successor
     * admission for an automatic link (spec 7.2). */
    maxGapMinutes: 120,
    /*
     * A successor that starts BEFORE the prior discharge links only as
     * "probable" and always raises a warning (spec 8.3 step 6).
     *
     * The spec's initial default was 15 minutes; live data showed registration
     * entering the IP admission up to ~45 minutes before the SB discharge on a
     * genuine SB -> IP transition, so the default is 60 (spec B.1: adjust the
     * centralized configuration when observed exports conflict with the
     * document, with the rule version updated - see TRANS_001 v1.1). The
     * discharge code remains the driving signal: a wider tolerance never links
     * anything that lacks a transition code, and ambiguity still refuses.
     */
    overlapToleranceMinutes: 60,
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
    deduplicateIdenticalRows: true,
    /*
     * Share of the busiest month's activity a neighbouring month must carry
     * before the inferred reporting period extends into it. Stops a few long
     * swing-bed stays that began months earlier from stretching a one-month
     * export across a quarter. Only affects the DEFAULT period; the user can
     * always set the dates explicitly.
     */
    periodInferenceShare: 0.2
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
      'Internal transition', 'Discharged home', 'Home with services',
      'Left against medical advice', 'Hospice', 'Skilled nursing facility',
      'Intermediate care', 'Rehabilitation facility', 'Long-term care hospital',
      'Psychiatric hospital', 'Acute care transfer', 'Federal or VA hospital',
      'Court or law enforcement', 'Death', 'Other', 'Unknown'
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

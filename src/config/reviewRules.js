/*
 * reviewRules.js - registry of objective review-queue triggers (spec 10).
 *
 * A review trigger identifies an account that SHOULD BE LOOKED AT by a human.
 * No entry in this file expresses a clinical, medical-necessity, denial, or
 * compliance conclusion, and none may be added that does. The Review Queue is
 * a work list, not a determination.
 *
 * The generator functions live in src/review/reviewQueue.js and are bound by
 * rule id; this file stays declarative so the Calculation Reference (in-app and
 * exported) is generated from it.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var C = UR.CLASSIFICATION;

  function t(label, configPath, note) {
    return { label: label, configPath: configPath, note: note || '' };
  }

  var DISCLAIMER = 'Objective identification only. This trigger does not determine medical necessity, appropriateness of status, payment, or compliance.';

  var REVIEW_RULES = [
    {
      id: 'RQ_IP_GT4', version: '1.0', priority: 20,
      name: 'Acute inpatient stay longer than 4 days',
      classification: C.OPERATIONAL,
      trigger: 'Acute IP LOS greater than 96 hours.',
      definition: 'Lists every discharged acute inpatient account exceeding the 96-hour operational target, with the excess days quantified.',
      formula: 'losHours > thresholds.acuteTargetHours',
      thresholds: [t('Long-stay threshold (hours)', 'thresholds.acuteTargetHours')],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'LOS hours', 'LOS days', 'Excess days'],
      sourceRefs: ['R1', 'R2'],
      notes: DISCLAIMER + ' Long stays may be entirely appropriate; the list supports continued-stay review and discharge-planning follow-up.',
      relatedRules: ['IP_GT4_001', 'IP_EXCESS_001']
    },
    {
      id: 'RQ_OS_24', version: '1.0', priority: 30,
      name: 'Observation longer than 24 hours',
      classification: C.OPERATIONAL,
      trigger: 'Observation duration greater than 24 hours.',
      definition: 'Observation accounts past the 24-hour mark, useful for status review and Medicare notice screening. Accounts still open at export time are included with their elapsed time measured to the as-of datetime, so a patient currently in observation is not missed.',
      formula: 'observationHours > thresholds.obsThresholdHours[0]; for open accounts, hours are measured from admission to the as-of datetime',
      thresholds: [t('Observation threshold 1 (hours)', 'thresholds.obsThresholdHours.0')],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'Observation hours'],
      sourceRefs: ['R3'],
      notes: DISCLAIMER,
      relatedRules: ['OS_24_001']
    },
    {
      id: 'RQ_OS_36', version: '1.0', priority: 25,
      name: 'Observation longer than 36 hours',
      classification: C.OPERATIONAL,
      trigger: 'Observation duration greater than 36 hours.',
      definition: 'Escalated observation-duration flag. Open accounts are included, measured to the as-of datetime.',
      formula: 'observationHours > thresholds.obsThresholdHours[1]; for open accounts, hours are measured from admission to the as-of datetime',
      thresholds: [t('Observation threshold 2 (hours)', 'thresholds.obsThresholdHours.1')],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'Observation hours'],
      sourceRefs: ['R3'],
      notes: DISCLAIMER,
      relatedRules: ['OS_36_001']
    },
    {
      id: 'RQ_OS_48', version: '1.0', priority: 10,
      name: 'Observation longer than 48 hours',
      classification: C.OPERATIONAL,
      trigger: 'Observation duration greater than 48 hours.',
      definition: 'High-priority prolonged observation flag. Open accounts are included, measured to the as-of datetime.',
      formula: 'observationHours > thresholds.obsThresholdHours[2]; for open accounts, hours are measured from admission to the as-of datetime',
      thresholds: [t('Observation threshold 3 (hours)', 'thresholds.obsThresholdHours.2')],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'Observation hours'],
      sourceRefs: ['R3'],
      notes: DISCLAIMER + ' Prolonged observation warrants prompt status review.',
      relatedRules: ['OS_48_001']
    },
    {
      id: 'RQ_OS_IP', version: '1.0', priority: 40,
      name: 'Confirmed observation to inpatient conversion',
      classification: C.OPERATIONAL,
      trigger: 'Accepted internal OS -> IP transition.',
      definition: 'Lists the observation account and the linked inpatient account with the transition gap in minutes.',
      formula: 'link.fromService = OS and link.toService = IP and confidence in {Confirmed, Probable}',
      thresholds: [],
      fields: ['OS account', 'IP account', 'MRN', 'Patient name', 'Payer category', 'OS hours before conversion', 'Gap minutes', 'Link confidence', 'Episode ID'],
      sourceRefs: ['HOSP'],
      notes: DISCLAIMER,
      relatedRules: ['OSIP_001', 'OSIP_TIME_001']
    },
    {
      id: 'RQ_IP_SB', version: '1.0', priority: 50,
      name: 'Confirmed inpatient to swing-bed transition',
      classification: C.OPERATIONAL,
      trigger: 'Accepted internal IP -> SB transition.',
      definition: 'Lists linked accounts for continuity visibility.',
      formula: 'link.fromService = IP and link.toService = SB and confidence in {Confirmed, Probable}',
      thresholds: [],
      fields: ['IP account', 'SB account', 'MRN', 'Patient name', 'Payer category', 'Gap minutes', 'Link confidence', 'Episode ID'],
      sourceRefs: ['HOSP'],
      notes: DISCLAIMER,
      relatedRules: ['IPSB_001']
    },
    {
      id: 'RQ_SB_IP', version: '1.0', priority: 50,
      name: 'Confirmed swing-bed to inpatient transition',
      classification: C.OPERATIONAL,
      trigger: 'Accepted internal SB -> IP transition.',
      definition: 'Lists linked accounts, which must remain within the same continuous episode.',
      formula: 'link.fromService = SB and link.toService = IP and confidence in {Confirmed, Probable}',
      thresholds: [],
      fields: ['SB account', 'IP account', 'MRN', 'Patient name', 'Payer category', 'Gap minutes', 'Link confidence', 'Episode ID'],
      sourceRefs: ['HOSP'],
      notes: DISCLAIMER + ' Driven by the hospital-specific reading of discharge code V.',
      relatedRules: ['SBIP_001']
    },
    {
      id: 'RQ_SHORT_MCR', version: '1.0', priority: 15,
      name: 'Medicare / Medicare Advantage inpatient crossing fewer than 2 midnights',
      classification: C.REGULATORY,
      trigger: 'Medicare FFS or MA inpatient account crossing fewer than two local midnights.',
      definition: 'Status-review candidate list.',
      formula: 'serviceClass = IP and payerCategory in {Medicare FFS, Medicare Advantage} and midnightsCrossed < thresholds.shortStayMidnights',
      thresholds: [t('Midnight threshold', 'thresholds.shortStayMidnights')],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'Midnights crossed', 'LOS hours'],
      sourceRefs: ['R5'],
      notes: DISCLAIMER + ' DO NOT LABEL THESE INAPPROPRIATE. The two-midnight benchmark rests on the physician expectation at admission, and case-by-case exceptions and inpatient-only procedures exist; none of that is visible in this data.',
      relatedRules: ['IP_2MN_001']
    },
    {
      id: 'RQ_1DAY', version: '1.0', priority: 35,
      name: 'One-day acute inpatient stay',
      classification: C.OPERATIONAL,
      trigger: 'Acute inpatient stay of 24 elapsed hours or less.',
      definition: 'Lists short inpatient stays with payer subsets.',
      formula: '0 < losHours <= thresholds.oneDayStayHours',
      thresholds: [t('One-day stay ceiling (hours)', 'thresholds.oneDayStayHours')],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'LOS hours', 'Midnights crossed'],
      sourceRefs: ['HOSP'],
      notes: DISCLAIMER,
      relatedRules: ['IP_SHORT_001']
    },
    {
      id: 'RQ_READMIT_7', version: '1.0', priority: 15,
      name: 'Potential 7-day readmission',
      classification: C.OPERATIONAL,
      trigger: 'New acute inpatient episode within 7 days of a prior episode final discharge.',
      definition: 'Lists the prior episode and the new inpatient account with the days between.',
      formula: '0 < daysBetween <= thresholds.readmissionWindowDays[0]',
      thresholds: [t('Short readmission window (days)', 'thresholds.readmissionWindowDays.0')],
      fields: ['New IP account', 'Prior episode ID', 'Prior final discharge', 'MRN', 'Patient name', 'Payer category', 'Days between', 'Prior disposition'],
      sourceRefs: ['HOSP'],
      notes: DISCLAIMER + ' An internal operational indicator, not a CMS readmission measure.',
      relatedRules: ['READMIT_7_001']
    },
    {
      id: 'RQ_READMIT_30', version: '1.0', priority: 25,
      name: 'Potential 30-day readmission',
      classification: C.OPERATIONAL,
      trigger: 'New acute inpatient episode within 30 days of a prior episode final discharge.',
      definition: 'Lists the prior episode and the new inpatient account with the days between.',
      formula: '0 < daysBetween <= thresholds.readmissionWindowDays[1]',
      thresholds: [t('Long readmission window (days)', 'thresholds.readmissionWindowDays.1')],
      fields: ['New IP account', 'Prior episode ID', 'Prior final discharge', 'MRN', 'Patient name', 'Payer category', 'Days between', 'Prior disposition'],
      sourceRefs: ['HOSP'],
      notes: DISCLAIMER + ' An internal operational indicator, not a CMS readmission measure.',
      relatedRules: ['READMIT_30_001', 'READMIT_MCR_001']
    },
    {
      id: 'RQ_IMM', version: '1.0', priority: 30,
      name: 'IMM manual check candidate',
      classification: C.REGULATORY,
      trigger: 'Medicare FFS or MA acute inpatient admission.',
      definition: 'Lists every mapped Medicare FFS and Medicare Advantage acute inpatient admission as a candidate for manual Important Message verification.',
      formula: 'serviceClass = IP and payerCategory in {Medicare FFS, Medicare Advantage}, where the category comes from the hospital insurance table',
      thresholds: [],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'LOS hours', 'Follow-up copy due window'],
      sourceRefs: ['R4'],
      notes: 'ELIGIBILITY LIST ONLY - THIS IS NOT PROOF OF DELIVERY. CPSI cannot export scanned or signed notice status, so the tool cannot verify that an Important Message was delivered, signed, or that any required follow-up copy was issued. Every listed account still requires manual confirmation.',
      relatedRules: []
    },
    {
      id: 'RQ_MOON', version: '1.0', priority: 30,
      name: 'MOON manual check candidate',
      classification: C.REGULATORY,
      trigger: 'Medicare FFS or MA observation account exceeding 24 hours.',
      definition: 'Lists mapped Medicare observation accounts past 24 hours, showing the 24- and 36-hour milestones. Accounts still open at export time are included, measured to the as-of datetime.',
      formula: 'serviceClass = OS and payerCategory in {Medicare FFS, Medicare Advantage} and observationHours > thresholds.moonThresholdHours; for open accounts, hours are measured from admission to the as-of datetime',
      thresholds: [
        t('MOON screening threshold (hours)', 'thresholds.moonThresholdHours'),
        t('Escalated observation threshold (hours)', 'thresholds.obsThresholdHours.1')
      ],
      fields: ['Account', 'MRN', 'Patient name', 'Payer category', 'Admit', 'Discharge', 'Observation hours', 'Past 24h', 'Past 36h'],
      sourceRefs: ['R3'],
      notes: 'ELIGIBILITY LIST ONLY - THIS IS NOT PROOF OF DELIVERY. CPSI cannot export scanned or signed MOON status. Timing requirements are policy-driven and must be verified against current CMS guidance and hospital procedure.',
      relatedRules: ['OS_24_001']
    },
    {
      id: 'RQ_TRANSITION', version: '1.0', priority: 20,
      name: 'Transition inconsistency',
      classification: C.DATA_QUALITY,
      trigger: 'Expected successor missing, ambiguous candidates, unexpected service, or suspicious timing.',
      definition: 'Lists accounts whose internal status transition could not be reconstructed cleanly, so the affected metrics can be interpreted correctly.',
      formula: 'link.confidence in {Ambiguous, Missing successor} OR probable overlap link OR gap > transition.suspiciousGapMinutes OR possible uncoded same-day transition',
      thresholds: [
        t('Maximum transition gap (minutes)', 'transition.maxGapMinutes'),
        t('Suspicious gap threshold (minutes)', 'transition.suspiciousGapMinutes'),
        t('Negative overlap tolerance (minutes)', 'transition.overlapToleranceMinutes')
      ],
      fields: ['Account', 'MRN', 'Patient name', 'Service', 'Discharge code', 'Issue', 'Candidate accounts', 'Gap minutes'],
      sourceRefs: ['HOSP'],
      notes: 'Affects episode construction and therefore readmission and episode counts. Resolve these before treating a run as final.',
      relatedRules: ['TRANS_001', 'EPISODE_001']
    },
    {
      id: 'RQ_DATA', version: '1.0', priority: 20,
      name: 'Data defect affecting interpretation',
      classification: C.DATA_QUALITY,
      trigger: 'Missing or invalid fields, unknown codes, or duplicate accounts on a record that participates in metrics.',
      definition: 'Surfaces account-level data defects into the same work list the reviewer already uses, so a defective record is not silently dropped.',
      formula: 'account has at least one Blocking or Error diagnostic, or a Warning that changes metric interpretation',
      thresholds: [],
      fields: ['Account', 'MRN', 'Service', 'Issue', 'Severity', 'Diagnostic rule'],
      sourceRefs: ['HOSP'],
      notes: 'Correct the source export or the reference mappings and reprocess.',
      relatedRules: []
    }
  ];

  var byId = {};
  for (var i = 0; i < REVIEW_RULES.length; i++) { byId[REVIEW_RULES[i].id] = REVIEW_RULES[i]; }

  UR.reviewRules = {
    RULES: REVIEW_RULES,
    byId: function (id) { return byId[id] || null; },
    ids: function () {
      var out = [];
      for (var j = 0; j < REVIEW_RULES.length; j++) { out.push(REVIEW_RULES[j].id); }
      return out;
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

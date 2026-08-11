/*
 * calculationRules.js - the central calculation rule registry (spec 9, 15.2,
 * Appendix B).
 *
 * This registry is the single source of truth for what every derived number
 * means. The in-app Calculation Reference page and the exported Calculation
 * Reference worksheet are both GENERATED from these records - they are never
 * maintained as separate prose. When a formula changes, bump that rule's
 * `version` here and update its metadata in the same edit (spec 15.3).
 *
 * `thresholds` entries carry a configPath instead of a copied number so the
 * reference always renders the value the engine actually used.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var C = UR.CLASSIFICATION;

  /* Threshold descriptor bound to a live configuration path. */
  function t(label, configPath, note) {
    return { label: label, configPath: configPath, note: note || '' };
  }

  function rule(r) {
    return {
      id: r.id,
      version: r.version || '1.0',
      name: r.name,
      classification: r.classification,
      definition: r.definition,
      formula: r.formula,
      inputs: r.inputs || [],
      inclusions: r.inclusions || [],
      exclusions: r.exclusions || [],
      thresholds: r.thresholds || [],
      nullHandling: r.nullHandling || 'Not applicable.',
      sourceRefs: r.sourceRefs || ['HOSP'],
      notes: r.notes || '',
      implementationKey: r.implementationKey || ''
    };
  }

  var COMMON_INCLUSIONS = 'Service accounts whose service code maps to an included behavior (IP, OS, or SB) in the editable service-code table.';
  var PERIOD_NOTE = 'The reporting period is a user-selected wall-clock date range, inclusive of both endpoints.';

  var RULES = [

    /* ------------------------------------------------ structural / linkage */
    rule({
      id: 'EPISODE_001',
      name: 'Continuous hospital episode construction',
      classification: C.HOSPITAL,
      definition: 'Source accounts connected by confirmed or probable internal status transitions are grouped under one generated Episode ID. Each source account keeps its own service-level length of stay.',
      formula: 'Group accounts by MRN, sort by admission datetime then account number; join accounts joined by an accepted transition link into a single episode; an account with no accepted link forms an episode of one.',
      inputs: ['MRN', 'Account number', 'Service code', 'Admission datetime', 'Discharge datetime', 'Discharge code'],
      inclusions: [COMMON_INCLUSIONS],
      exclusions: ['Excluded and unknown service codes never join an episode.', 'Ambiguous transitions are left unlinked rather than guessed.'],
      nullHandling: 'A record without a usable MRN or admission datetime cannot be linked and forms a one-account episode with a data-quality warning.',
      notes: 'CPSI opens a new account when a patient changes status, so an OS -> IP -> SB course is four accounts and one episode. Episodes exist so internal transitions are never counted as readmissions.',
      implementationKey: 'episodeBuilder.buildEpisodes'
    }),

    rule({
      id: 'TRANS_001',
      name: 'Internal status-transition linkage',
      classification: C.HOSPITAL,
      definition: 'An account whose discharge code implies an internal status change is linked to the next same-MRN account carrying the expected service, when the timing satisfies the configured tolerances.',
      formula: 'For a discharging account with a transition discharge code: consider same-MRN accounts of the expected target service admitted at or after the discharge datetime minus the overlap tolerance; require the same calendar date when configured; choose the smallest nonnegative gap within the maximum gap. Exactly one candidate links as Confirmed; a candidate starting before the discharge but inside the overlap tolerance links as Probable with a warning; two or more plausible candidates are flagged Ambiguous and left unlinked; none is flagged Missing Expected Successor.',
      inputs: ['MRN', 'Service code', 'Admission datetime', 'Discharge datetime', 'Discharge code'],
      inclusions: ['Discharge codes configured with a transition target, restricted by source service where configured (B: OS -> IP; Q: IP/OS -> SB; V: SB -> IP).'],
      exclusions: ['Timing alone never creates a link. A same-day service change with no transition discharge code is reported as a possible uncoded transition and left unlinked (spec 8.3 step 9).'],
      thresholds: [
        t('Maximum transition gap (minutes)', 'transition.maxGapMinutes'),
        t('Negative overlap tolerance (minutes)', 'transition.overlapToleranceMinutes'),
        t('Same calendar date required', 'transition.requireSameCalendarDate'),
        t('Suspicious gap threshold (minutes)', 'transition.suspiciousGapMinutes')
      ],
      nullHandling: 'Missing MRN, admission datetime, or discharge datetime disables linkage for that account and raises a warning.',
      sourceRefs: ['HOSP'],
      notes: 'Code V is a hospital-specific reading; the published meaning is transfer to a Critical Access Hospital.',
      implementationKey: 'transitionLinker.linkTransitions'
    }),

    /* ---------------------------------------------------- inpatient metrics */
    rule({
      id: 'IP_ADM_001',
      name: 'Acute inpatient admissions',
      classification: C.OPERATIONAL,
      definition: 'Count of distinct included acute inpatient service accounts whose IP admission datetime falls within the reporting period. Unique continuous episodes are reported separately.',
      formula: 'count(accounts where serviceClass = IP and admissionDateTime within reporting period)',
      inputs: ['Service code', 'Admission datetime', 'Account number'],
      inclusions: ['IP service accounts, including IP accounts created by an internal OS -> IP or SB -> IP status change.'],
      exclusions: ['Accounts with an unparseable admission datetime.', 'Accounts admitted outside the reporting period.'],
      nullHandling: 'An account with no usable admission datetime is excluded and reported as an error.',
      notes: 'This is a SERVICE-ACCOUNT count and therefore includes internal status changes. Compare with EPISODE_CNT_001 before publishing an "admissions" figure. ' + PERIOD_NOTE,
      implementationKey: 'metrics.inpatient.admissions'
    }),

    rule({
      id: 'IP_LOS_001',
      name: 'Acute inpatient length of stay',
      classification: C.OPERATIONAL,
      definition: 'For each discharged IP account, elapsed time from IP admission datetime to IP discharge datetime. Observation and swing-bed time are never folded into the acute segment.',
      formula: 'losHours = dischargeDateTime - admissionDateTime, in elapsed hours; losDays = losHours / 24',
      inputs: ['Admission datetime', 'Discharge datetime'],
      inclusions: ['Discharged IP accounts.'],
      exclusions: ['Open encounters.', 'Accounts whose discharge precedes admission beyond the overlap tolerance (reported as an error).'],
      nullHandling: 'Missing discharge datetime marks the account Open Encounter and removes it from LOS-based metrics.',
      notes: 'Segment-level by design: keeping OS/SB time out of the acute segment is what makes the CAH 96-hour surveillance figure meaningful (R1).',
      sourceRefs: ['R1'],
      implementationKey: 'metrics.inpatient.los'
    }),

    rule({
      id: 'IP_ALOS_001',
      name: 'Acute inpatient mean length of stay',
      classification: C.OPERATIONAL,
      definition: 'Arithmetic mean of IP_LOS_001 across qualifying discharged IP accounts, reported in both hours and days.',
      formula: 'mean(losHours of qualifying discharged IP accounts); days = hours / 24',
      inputs: ['IP_LOS_001'],
      inclusions: ['Discharged IP accounts whose qualifying datetime falls in the reporting period.'],
      exclusions: ['Open encounters.', 'Swing-bed and observation segments.', 'Accounts with invalid dates.'],
      thresholds: [t('Period basis for discharged stays', 'processing.losBasis', 'discharge = the stay counts in the period it ended; admission = the period it began.')],
      nullHandling: 'Returns no value when the qualifying set is empty rather than reporting zero.',
      notes: 'The period basis is configurable and is stated with the metric so two runs are never silently different.',
      implementationKey: 'metrics.inpatient.alos'
    }),

    rule({
      id: 'IP_MEDLOS_001',
      name: 'Acute inpatient median length of stay',
      classification: C.OPERATIONAL,
      definition: 'Median of qualifying discharged acute inpatient LOS hours.',
      formula: 'median(losHours); even counts use the mean of the two central values',
      inputs: ['IP_LOS_001'],
      inclusions: ['Same qualifying set as IP_ALOS_001.'],
      exclusions: ['Open encounters.'],
      nullHandling: 'No value when the qualifying set is empty.',
      notes: 'Reported next to the mean because a single long stay moves a 25-bed hospital mean substantially.',
      implementationKey: 'metrics.inpatient.medianLos'
    }),

    rule({
      id: 'CAH96_001',
      name: 'CAH 96-hour surveillance estimate',
      classification: C.REGULATORY,
      definition: 'Mean acute inpatient LOS in hours for qualifying discharged IP segments in the selected period, compared with the 96-hour Critical Access Hospital annual-average expectation.',
      formula: 'meanAcuteIPLosHours - 96; also reported as a ratio to 96 hours',
      inputs: ['IP_ALOS_001'],
      inclusions: ['Acute inpatient segments only.'],
      exclusions: ['Swing-bed services and distinct-part unit days, consistent with the CAH annual-average definition.', 'Observation time.', 'Open encounters.'],
      thresholds: [t('CAH acute target (hours)', 'thresholds.acuteTargetHours')],
      nullHandling: 'No value when no qualifying discharged IP accounts exist in the period.',
      sourceRefs: ['R1', 'R2'],
      notes: 'SURVEILLANCE ESTIMATE ONLY. The CAH requirement is an ANNUAL average across the cost-reporting year; a monthly figure is an early-warning aid. Do not treat this as an official certification calculation until it has been validated against the hospital cost report methodology.',
      implementationKey: 'metrics.inpatient.cah96'
    }),

    rule({
      id: 'IP_TARGET_001',
      name: 'Four-day operational target variance',
      classification: C.OPERATIONAL,
      definition: 'Difference between the mean acute inpatient LOS in days and the hospital 4.0-day operational target.',
      formula: 'meanAcuteIPLosDays - 4.0',
      inputs: ['IP_ALOS_001'],
      inclusions: ['Qualifying discharged IP accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Operational target (days)', 'thresholds.acuteTargetDays')],
      nullHandling: 'No value when the mean is unavailable.',
      notes: 'An internal management target expressed alongside the regulatory surveillance figure, not a substitute for it.',
      implementationKey: 'metrics.inpatient.targetVariance'
    }),

    rule({
      id: 'IP_GT4_001',
      name: 'Acute inpatient stays longer than four days',
      classification: C.OPERATIONAL,
      definition: 'Count and percentage of discharged acute inpatient accounts with LOS strictly greater than 96 hours, with the supporting account list.',
      formula: 'count(losHours > 96); percent = count / qualifying discharged IP accounts * 100',
      inputs: ['IP_LOS_001'],
      inclusions: ['Qualifying discharged IP accounts.'],
      exclusions: ['Open encounters.', 'Swing-bed and observation segments.'],
      thresholds: [t('Long-stay threshold (hours)', 'thresholds.acuteTargetHours')],
      nullHandling: 'Open encounters are excluded from both numerator and denominator.',
      notes: 'Strictly greater than: a stay of exactly 96.0 hours is not counted.',
      implementationKey: 'metrics.inpatient.gt4'
    }),

    rule({
      id: 'IP_EXCESS_001',
      name: 'Excess days above the acute target',
      classification: C.OPERATIONAL,
      definition: 'Total and average days by which long acute inpatient stays exceed the 96-hour target.',
      formula: 'perAccount = max(losHours - 96, 0) / 24; reported as sum over all qualifying accounts and as the mean over accounts exceeding the threshold',
      inputs: ['IP_LOS_001'],
      inclusions: ['Qualifying discharged IP accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Acute target (hours)', 'thresholds.acuteTargetHours')],
      nullHandling: 'Accounts at or below the threshold contribute zero excess.',
      notes: 'Total excess days quantifies the size of the opportunity; the average describes only accounts that exceeded the target.',
      implementationKey: 'metrics.inpatient.excessDays'
    }),

    rule({
      id: 'IP_SHORT_001',
      name: 'One-day acute inpatient stay',
      classification: C.OPERATIONAL,
      definition: 'Discharged acute inpatient accounts with an elapsed duration greater than 0 and at most 24 hours, broken down by mapped payer category.',
      formula: 'count(0 < losHours <= 24), grouped by payer category',
      inputs: ['IP_LOS_001', 'Payer category'],
      inclusions: ['Qualifying discharged IP accounts.'],
      exclusions: ['Open encounters.', 'Zero-length or negative durations, which are reported as data errors instead.'],
      thresholds: [t('One-day stay ceiling (hours)', 'thresholds.oneDayStayHours')],
      nullHandling: 'Unmapped insurance codes group under the Unknown payer category.',
      notes: 'An elapsed-hours definition, not a midnight count. IP_2MN_001 is the midnight-based companion.',
      implementationKey: 'metrics.inpatient.oneDayStays'
    }),

    rule({
      id: 'IP_2MN_001',
      name: 'Short Medicare / Medicare Advantage inpatient review indicator',
      classification: C.REGULATORY,
      definition: 'Acute inpatient accounts mapped to Medicare FFS or Medicare Advantage that cross fewer than two local midnights. An objective review flag only.',
      formula: 'count(serviceClass = IP and payerCategory in {Medicare FFS, Medicare Advantage} and midnightsCrossed < 2)',
      inputs: ['Service code', 'Admission datetime', 'Discharge datetime', 'Payer category'],
      inclusions: ['Discharged Medicare FFS and Medicare Advantage IP accounts.'],
      exclusions: ['Open encounters, whose final midnight count is not yet known.', 'Non-Medicare payer categories.', 'Accounts whose insurance code has not been mapped.'],
      thresholds: [t('Midnight threshold', 'thresholds.shortStayMidnights')],
      nullHandling: 'Unmapped payers are excluded from the numerator and listed as an unknown-payer warning so the gap is visible.',
      sourceRefs: ['R5'],
      notes: 'IDENTIFIES REVIEW CANDIDATES ONLY. This does not determine that inpatient status was inappropriate, and it does not evaluate the physician expectation of a two-midnight stay, the case-by-case exception, or inpatient-only procedures.',
      implementationKey: 'metrics.inpatient.shortMedicareStays'
    }),

    /* -------------------------------------------------- observation metrics */
    rule({
      id: 'OS_ADM_001',
      name: 'Observation admissions',
      classification: C.OPERATIONAL,
      definition: 'Count of distinct observation service accounts admitted during the reporting period.',
      formula: 'count(accounts where serviceClass = OS and admissionDateTime within reporting period)',
      inputs: ['Service code', 'Admission datetime'],
      inclusions: ['OS service accounts.'],
      exclusions: ['Accounts admitted outside the reporting period.', 'Unparseable admission datetimes.'],
      nullHandling: 'Accounts without a usable admission datetime are excluded and reported as errors.',
      notes: PERIOD_NOTE,
      implementationKey: 'metrics.observation.admissions'
    }),

    rule({
      id: 'OS_LOS_001',
      name: 'Observation duration',
      classification: C.OPERATIONAL,
      definition: 'Elapsed hours from observation admission datetime to observation discharge datetime.',
      formula: 'hours = dischargeDateTime - admissionDateTime',
      inputs: ['Admission datetime', 'Discharge datetime'],
      inclusions: ['Discharged OS accounts.'],
      exclusions: ['Open observation encounters.'],
      nullHandling: 'Missing discharge datetime marks the account Open Encounter.',
      notes: 'Observation is measured in hours because the clinically and financially relevant thresholds are hourly (R3).',
      sourceRefs: ['R3'],
      implementationKey: 'metrics.observation.los'
    }),

    rule({
      id: 'OS_ALOS_001',
      name: 'Observation mean and median duration',
      classification: C.OPERATIONAL,
      definition: 'Mean and median observation hours for qualifying discharged OS accounts, also expressed in equivalent days for comparison with inpatient figures.',
      formula: 'mean(hours) and median(hours); equivalent days = hours / 24',
      inputs: ['OS_LOS_001'],
      inclusions: ['Qualifying discharged OS accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Period basis for discharged stays', 'processing.losBasis')],
      nullHandling: 'No value when the qualifying set is empty.',
      notes: 'The equivalent-days conversion is presentational only; observation is not an inpatient day.',
      implementationKey: 'metrics.observation.alos'
    }),

    rule({
      id: 'OS_24_001',
      name: 'Observation longer than 24 hours',
      classification: C.OPERATIONAL,
      definition: 'Count and account list for observation stays exceeding 24 hours.',
      formula: 'count(observationHours > 24)',
      inputs: ['OS_LOS_001'],
      inclusions: ['Qualifying discharged OS accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Observation threshold 1 (hours)', 'thresholds.obsThresholdHours.0')],
      nullHandling: 'Open encounters are excluded.',
      sourceRefs: ['R3'],
      notes: 'The 24-hour mark is also the MOON manual-check screening point for Medicare beneficiaries.',
      implementationKey: 'metrics.observation.overThreshold'
    }),

    rule({
      id: 'OS_36_001',
      name: 'Observation longer than 36 hours',
      classification: C.OPERATIONAL,
      definition: 'Count and account list for observation stays exceeding 36 hours.',
      formula: 'count(observationHours > 36)',
      inputs: ['OS_LOS_001'],
      inclusions: ['Qualifying discharged OS accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Observation threshold 2 (hours)', 'thresholds.obsThresholdHours.1')],
      nullHandling: 'Open encounters are excluded.',
      notes: 'Escalated duration flag for status review.',
      implementationKey: 'metrics.observation.overThreshold'
    }),

    rule({
      id: 'OS_48_001',
      name: 'Observation longer than 48 hours',
      classification: C.OPERATIONAL,
      definition: 'Count and account list for observation stays exceeding 48 hours.',
      formula: 'count(observationHours > 48)',
      inputs: ['OS_LOS_001'],
      inclusions: ['Qualifying discharged OS accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Observation threshold 3 (hours)', 'thresholds.obsThresholdHours.2')],
      nullHandling: 'Open encounters are excluded.',
      notes: 'High-priority prolonged observation flag.',
      implementationKey: 'metrics.observation.overThreshold'
    }),

    rule({
      id: 'OSIP_001',
      name: 'Observation to inpatient conversions',
      classification: C.OPERATIONAL,
      definition: 'Count of confirmed or probable internal OS -> IP status transitions whose observation segment began in the reporting period.',
      formula: 'count(transition links where fromService = OS, toService = IP, confidence in {Confirmed, Probable})',
      inputs: ['TRANS_001'],
      inclusions: ['Accepted internal transitions only.'],
      exclusions: ['Ambiguous candidates.', 'Missing successors.', 'Timing-only same-day service changes with no transition discharge code.'],
      nullHandling: 'Unlinked accounts are excluded and surfaced in the Transitions worksheet.',
      notes: 'Probable links are included in the count and separately identified in the Transitions worksheet.',
      implementationKey: 'metrics.observation.conversions'
    }),

    rule({
      id: 'OSIP_RATE_001',
      name: 'Observation to inpatient conversion rate',
      classification: C.OPERATIONAL,
      definition: 'Accepted OS -> IP transitions divided by the observation accounts eligible for conversion analysis.',
      formula: 'rate = acceptedOSIPTransitions / eligibleOSAccounts * 100, where eligibleOSAccounts = OS accounts admitted in the period that are neither open nor invalid',
      inputs: ['OSIP_001', 'OS_ADM_001'],
      inclusions: ['OS accounts admitted within the reporting period with a usable admission and discharge datetime.'],
      exclusions: ['Open observation encounters, whose outcome is not yet known.', 'OS accounts with invalid dates.'],
      nullHandling: 'No rate is reported when the eligible denominator is zero.',
      notes: 'The denominator and the excluded record counts are exported alongside the rate so the figure can be reconciled.',
      implementationKey: 'metrics.observation.conversionRate'
    }),

    rule({
      id: 'OSIP_TIME_001',
      name: 'Time in observation before inpatient conversion',
      classification: C.OPERATIONAL,
      definition: 'For accepted OS -> IP transitions, the duration of the observation segment before the status change.',
      formula: 'observationSegmentHours for the OS account of each accepted OS -> IP link; reported as mean and median',
      inputs: ['OSIP_001', 'OS_LOS_001'],
      inclusions: ['Accepted OS -> IP transitions.'],
      exclusions: ['Unlinked or ambiguous observation accounts.'],
      nullHandling: 'No value when there are no accepted conversions.',
      notes: 'Measures decision latency: how long a patient stayed in observation before the status decision was made.',
      implementationKey: 'metrics.observation.timeToConversion'
    }),

    /* --------------------------------------------------- swing-bed metrics */
    rule({
      id: 'SB_ADM_001',
      name: 'Swing-bed admissions',
      classification: C.OPERATIONAL,
      definition: 'Count of distinct swing-bed accounts admitted during the reporting period.',
      formula: 'count(accounts where serviceClass = SB and admissionDateTime within reporting period)',
      inputs: ['Service code', 'Admission datetime'],
      inclusions: ['SB service accounts.'],
      exclusions: ['Accounts outside the reporting period.'],
      nullHandling: 'Accounts without a usable admission datetime are excluded and reported as errors.',
      implementationKey: 'metrics.swingBed.admissions'
    }),

    rule({
      id: 'SB_LOS_001',
      name: 'Swing-bed length of stay',
      classification: C.OPERATIONAL,
      definition: 'Elapsed time from swing-bed admission datetime to swing-bed discharge datetime.',
      formula: 'losHours = dischargeDateTime - admissionDateTime; losDays = losHours / 24',
      inputs: ['Admission datetime', 'Discharge datetime'],
      inclusions: ['Discharged SB accounts.'],
      exclusions: ['Open encounters.'],
      nullHandling: 'Missing discharge datetime marks the account Open Encounter.',
      sourceRefs: ['R1'],
      notes: 'Kept strictly separate from acute inpatient LOS: swing-bed days are excluded from the CAH 96-hour average.',
      implementationKey: 'metrics.swingBed.los'
    }),

    rule({
      id: 'SB_ALOS_001',
      name: 'Swing-bed mean and median length of stay',
      classification: C.OPERATIONAL,
      definition: 'Mean and median duration of qualifying discharged swing-bed accounts, in hours and days.',
      formula: 'mean(losHours) and median(losHours); days = hours / 24',
      inputs: ['SB_LOS_001'],
      inclusions: ['Qualifying discharged SB accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [t('Period basis for discharged stays', 'processing.losBasis')],
      nullHandling: 'No value when the qualifying set is empty.',
      implementationKey: 'metrics.swingBed.alos'
    }),

    rule({
      id: 'IPSB_001',
      name: 'Inpatient to swing-bed transitions',
      classification: C.OPERATIONAL,
      definition: 'Count of accepted internal IP -> SB status transitions.',
      formula: 'count(links where fromService = IP, toService = SB, confidence in {Confirmed, Probable})',
      inputs: ['TRANS_001'],
      inclusions: ['Accepted internal transitions.'],
      exclusions: ['Ambiguous or missing successors.'],
      nullHandling: 'Unlinked accounts are excluded and listed in diagnostics.',
      implementationKey: 'metrics.swingBed.transitions'
    }),

    rule({
      id: 'OSSB_001',
      name: 'Observation to swing-bed transitions',
      classification: C.OPERATIONAL,
      definition: 'Count of accepted internal OS -> SB status transitions, when present.',
      formula: 'count(links where fromService = OS, toService = SB, confidence in {Confirmed, Probable})',
      inputs: ['TRANS_001'],
      inclusions: ['Accepted internal transitions.'],
      exclusions: ['Ambiguous or missing successors.'],
      nullHandling: 'Reported as zero when the pattern does not occur.',
      notes: 'Uncommon locally; reported so an unexpected occurrence is visible rather than absorbed.',
      implementationKey: 'metrics.swingBed.transitions'
    }),

    rule({
      id: 'SBIP_001',
      name: 'Swing-bed to inpatient transitions',
      classification: C.OPERATIONAL,
      definition: 'Count of accepted internal SB -> IP status transitions.',
      formula: 'count(links where fromService = SB, toService = IP, confidence in {Confirmed, Probable})',
      inputs: ['TRANS_001'],
      inclusions: ['Accepted internal transitions, driven by the hospital-specific reading of discharge code V.'],
      exclusions: ['Ambiguous or missing successors.'],
      nullHandling: 'Unlinked accounts are excluded and listed in diagnostics.',
      sourceRefs: ['HOSP'],
      notes: 'Depends on the local use of code V. If the hospital changes that practice, update the discharge-code mapping rather than the metric.',
      implementationKey: 'metrics.swingBed.transitions'
    }),

    /* ------------------------------------------------ patient days / census */
    rule({
      id: 'PD_EQ_001',
      name: 'Equivalent patient days (time-weighted)',
      classification: C.OPERATIONAL,
      definition: 'Total included service occupancy hours falling inside the reporting period, divided by 24.',
      formula: 'sum(overlapHours(serviceInterval, reportingPeriod)) / 24',
      inputs: ['Service code', 'Admission datetime', 'Discharge datetime', 'Reporting period'],
      inclusions: ['IP, OS, and SB occupancy, reported per service and combined. Portions of a stay that extend outside the period contribute only their in-period hours.'],
      exclusions: ['Excluded and unknown service codes.'],
      thresholds: [
        t('Include open encounters in occupancy', 'processing.includeOpenInOccupancy'),
        t('Occupancy as-of datetime', 'reportingPeriod.asOf', 'Open encounters are counted through this datetime only.')
      ],
      nullHandling: 'Open encounters are truncated at the as-of datetime when included, and contribute nothing when excluded.',
      notes: 'PAIRED METHOD - reported alongside PD_MN_001 and NOT presented as the hospital official patient-day measure until validated against existing reporting (spec 9.5).',
      implementationKey: 'metrics.census.equivalentPatientDays'
    }),

    rule({
      id: 'PD_MN_001',
      name: 'Midnight census patient days',
      classification: C.OPERATIONAL,
      definition: 'For each local midnight in the reporting period, the number of included patients whose service interval spans that midnight, summed across the period.',
      formula: 'sum over each midnight M in period of count(accounts where admissionDateTime <= M < dischargeDateTime)',
      inputs: ['Service code', 'Admission datetime', 'Discharge datetime', 'Reporting period'],
      inclusions: ['IP, OS, and SB accounts occupying a bed at the midnight boundary, reported per service and combined.'],
      exclusions: ['Excluded and unknown service codes.', 'Stays that begin and end within a single calendar day, which by construction span no midnight.'],
      thresholds: [t('Include open encounters in occupancy', 'processing.includeOpenInOccupancy')],
      nullHandling: 'Open encounters are treated as still occupying through the as-of datetime when included.',
      notes: 'PAIRED METHOD - the traditional census convention. A patient present at midnight counts as one day regardless of hours.',
      implementationKey: 'metrics.census.midnightPatientDays'
    }),

    rule({
      id: 'ADC_EQ_001',
      name: 'Time-weighted average daily census',
      classification: C.OPERATIONAL,
      definition: 'Total included occupancy hours in the period divided by 24 times the number of calendar days in the period.',
      formula: 'totalInPeriodOccupancyHours / (24 * calendarDaysInPeriod)',
      inputs: ['PD_EQ_001', 'Reporting period'],
      inclusions: ['Same occupancy basis as PD_EQ_001.'],
      exclusions: ['Excluded and unknown service codes.'],
      nullHandling: 'No value when the reporting period contains no days.',
      notes: 'PAIRED METHOD - compare with ADC_MN_001 during validation.',
      implementationKey: 'metrics.census.timeWeightedADC'
    }),

    rule({
      id: 'ADC_MN_001',
      name: 'Midnight average daily census',
      classification: C.OPERATIONAL,
      definition: 'Midnight census patient days divided by the number of calendar days in the reporting period.',
      formula: 'PD_MN_001 / calendarDaysInPeriod',
      inputs: ['PD_MN_001', 'Reporting period'],
      inclusions: ['Same occupancy basis as PD_MN_001.'],
      exclusions: ['Excluded and unknown service codes.'],
      nullHandling: 'No value when the reporting period contains no days.',
      notes: 'PAIRED METHOD - compare with ADC_EQ_001 during validation.',
      implementationKey: 'metrics.census.midnightADC'
    }),

    /* -------------------------------------------- admissions / episodes / patients */
    rule({
      id: 'ADM_SVC_001',
      name: 'Total service admissions',
      classification: C.OPERATIONAL,
      definition: 'Acute inpatient plus observation plus swing-bed admissions counted at the service-account level.',
      formula: 'IP_ADM_001 + OS_ADM_001 + SB_ADM_001',
      inputs: ['IP_ADM_001', 'OS_ADM_001', 'SB_ADM_001'],
      inclusions: ['All included service accounts admitted in the period.'],
      exclusions: ['Excluded and unknown service codes.'],
      nullHandling: 'Counts of zero are reported as zero.',
      notes: 'INCLUDES INTERNAL STATUS TRANSITIONS and therefore counts one OS -> IP course twice. Always label it "service admissions" and show EPISODE_CNT_001 beside it.',
      implementationKey: 'metrics.census.serviceAdmissions'
    }),

    rule({
      id: 'EPISODE_CNT_001',
      name: 'Unique continuous episodes',
      classification: C.OPERATIONAL,
      definition: 'Count of generated Episode IDs whose first included service account begins within the reporting period.',
      formula: 'count(episodes where episodeStartDateTime within reporting period)',
      inputs: ['EPISODE_001'],
      inclusions: ['Episodes built from included service accounts.'],
      exclusions: ['Episodes that began before the reporting period, even if they continue into it.'],
      nullHandling: 'Episodes whose start datetime is unusable are excluded and reported as errors.',
      notes: 'RECOMMENDED as the primary hospital-episode count: internal status changes do not inflate it.',
      implementationKey: 'metrics.census.episodeCount'
    }),

    rule({
      id: 'PATIENT_CNT_001',
      name: 'Unique patients',
      classification: C.OPERATIONAL,
      definition: 'Count of distinct MRNs represented among included encounters in the reporting period.',
      formula: 'count(distinct MRN)',
      inputs: ['MRN'],
      inclusions: ['Included service accounts admitted in the period.'],
      exclusions: ['Records with a missing MRN, which cannot be attributed to a patient.'],
      nullHandling: 'Missing MRNs are counted separately as a data-quality warning rather than pooled into one pseudo-patient.',
      implementationKey: 'metrics.census.uniquePatients'
    }),

    /* ------------------------------------------------ readmission indicators */
    rule({
      id: 'READMIT_7_001',
      name: 'Internal 7-day readmission indicator',
      classification: C.OPERATIONAL,
      definition: 'A new acute inpatient episode for the same MRN beginning more than 0 and at most 7 days after the FINAL discharge of a prior continuous episode that contained acute inpatient care.',
      formula: 'for each pair of consecutive episodes of one MRN containing acute IP care: daysBetween = newEpisodeStart - priorEpisodeFinalDischarge; flag when 0 < daysBetween <= 7',
      inputs: ['EPISODE_001', 'MRN', 'Discharge datetime'],
      inclusions: ['Prior episodes that contained at least one acute IP account and ended with a true discharge.', 'Subsequent episodes that contain acute IP care.'],
      exclusions: ['Internal OS/IP/SB status transitions inside one episode - by construction these are one episode and can never be a readmission.', 'Prior episodes still open at the end of the data.', 'Pairs whose prior episode cannot be dated.'],
      thresholds: [t('Short readmission window (days)', 'thresholds.readmissionWindowDays.0')],
      nullHandling: 'Episodes near the start of the imported range may have no visible prior admission; the affected window is reported as an incomplete-lookback warning.',
      notes: 'INTERNAL OPERATIONAL INDICATOR. Not a CMS readmission rate: no risk standardization, no planned-readmission algorithm, no cross-facility data, and no condition cohorts.',
      implementationKey: 'readmissionDetector.detect'
    }),

    rule({
      id: 'READMIT_30_001',
      name: 'Internal 30-day readmission indicator',
      classification: C.OPERATIONAL,
      definition: 'The same logic as READMIT_7_001 using a window of more than 0 and at most 30 days.',
      formula: 'flag when 0 < daysBetween <= 30',
      inputs: ['EPISODE_001', 'MRN', 'Discharge datetime'],
      inclusions: ['Same as READMIT_7_001.'],
      exclusions: ['Same as READMIT_7_001.'],
      thresholds: [t('Long readmission window (days)', 'thresholds.readmissionWindowDays.1')],
      nullHandling: 'Same incomplete-lookback caveat as READMIT_7_001, over a 30-day horizon.',
      notes: 'INTERNAL OPERATIONAL INDICATOR. Do not label this a CMS readmission rate.',
      implementationKey: 'readmissionDetector.detect'
    }),

    rule({
      id: 'READMIT_MCR_001',
      name: 'Medicare 30-day readmission indicator',
      classification: C.OPERATIONAL,
      definition: 'The subset of READMIT_30_001 in which the readmitting acute inpatient account is mapped to Medicare FFS or Medicare Advantage. The two categories are also reported separately.',
      formula: 'subset of READMIT_30_001 where payerCategory of the readmitting IP account is Medicare FFS or Medicare Advantage',
      inputs: ['READMIT_30_001', 'Payer category'],
      inclusions: ['Readmission pairs whose new IP account maps to a Medicare category.'],
      exclusions: ['Non-Medicare and unmapped payer categories.'],
      nullHandling: 'Unmapped insurance codes are excluded and reported as an unknown-payer warning.',
      notes: 'INTERNAL OPERATIONAL INDICATOR based on the payer of the READMISSION, not of the index stay. Not a CMS risk-standardized measure.',
      implementationKey: 'readmissionDetector.detect'
    }),

    /* --------------------------- disposition / payer / source / mortality */
    rule({
      id: 'DEATH_001',
      name: 'Deaths',
      classification: C.OPERATIONAL,
      definition: 'Accounts whose discharge code maps to the Death category, reported as a count and percentage by service type and payer category.',
      formula: 'count(dischargeCodeCategory = Death); percent = deaths / discharged accounts in scope * 100',
      inputs: ['Discharge code', 'Service code', 'Payer category'],
      inclusions: ['Included service accounts with a discharge code mapped to Death (default code E).'],
      exclusions: ['Open encounters.', 'Accounts with no discharge code.'],
      nullHandling: 'A missing or unknown discharge code is never inferred to be a death; it raises an unknown-disposition warning.',
      notes: 'Depends entirely on discharge-code mapping accuracy. Verify the Death category in the discharge-code table before reporting.',
      implementationKey: 'metrics.payer.deaths'
    }),

    rule({
      id: 'DISPO_001',
      name: 'Discharge disposition distribution',
      classification: C.OPERATIONAL,
      definition: 'Distribution of mapped discharge-disposition categories with counts and percentages.',
      formula: 'count and percent of discharged accounts grouped by mapped discharge-code category',
      inputs: ['Discharge code'],
      inclusions: ['Discharged included service accounts.'],
      exclusions: ['Open encounters.'],
      nullHandling: 'Unmapped discharge codes are grouped under Unknown and listed in the Code Inventory.',
      notes: 'Internal transition codes (B, Q, V) appear as their own category and are not patient dispositions.',
      implementationKey: 'metrics.payer.dispositionDistribution'
    }),

    rule({
      id: 'PAYER_MIX_001',
      name: 'Payer mix',
      classification: C.OPERATIONAL,
      definition: 'Service accounts, unique episodes, inpatient occupancy hours and patient days, and selected review metrics grouped by mapped payer category and by raw insurance code.',
      formula: 'group included accounts by payerCategory and by raw insurance code; report counts, in-period occupancy hours, equivalent patient days, and review-flag counts',
      inputs: ['Insurance code', 'Payer category', 'Service code', 'Admission datetime', 'Discharge datetime'],
      inclusions: ['Included service accounts in the reporting period.'],
      exclusions: ['Excluded and unknown service codes.'],
      nullHandling: 'Unmapped insurance codes report under the Unknown category with their raw code preserved.',
      notes: 'Both mapped and raw views are exported so a mapping error is visible rather than hidden by aggregation.',
      implementationKey: 'metrics.payer.payerMix'
    }),

    rule({
      id: 'ADMSRC_001',
      name: 'Admission source summary',
      classification: C.OPERATIONAL,
      definition: 'Counts by mapped admission-source description and category when an admission-source column is provided.',
      formula: 'group included accounts by mapped admission source; report counts and percentages',
      inputs: ['Admission source'],
      inclusions: ['Included service accounts with an admission-source value.'],
      exclusions: ['Runs where no admission-source column was mapped, which report the metric as unavailable.'],
      nullHandling: 'Blank or unmapped values report as Unknown and appear in the Code Inventory.',
      notes: 'The raw CPSI field name for admission source was not established at design time; it is mapped canonically at import.',
      implementationKey: 'metrics.payer.admissionSources'
    }),

    rule({
      id: 'DOW_001',
      name: 'Admissions and discharges by day of week',
      classification: C.OPERATIONAL,
      definition: 'Counts of admissions and discharges by wall-clock day of week.',
      formula: 'group by dayOfWeek(admissionDateTime) and dayOfWeek(dischargeDateTime)',
      inputs: ['Admission datetime', 'Discharge datetime'],
      inclusions: ['Included service accounts in the reporting period.'],
      exclusions: ['Records with unusable datetimes.'],
      nullHandling: 'Open encounters contribute an admission but no discharge.',
      notes: 'Objective operational trend only; no staffing or appropriateness conclusion is implied.',
      implementationKey: 'metrics.payer.dayOfWeek'
    }),

    rule({
      id: 'LOSDIST_001',
      name: 'Acute inpatient LOS distribution',
      classification: C.OPERATIONAL,
      definition: 'Median, 75th and 90th percentile acute inpatient LOS, and counts within the bands at most 1 day, more than 1 to 2 days, more than 2 to 4 days, and more than 4 days.',
      formula: 'percentiles by linear interpolation (equivalent to Excel PERCENTILE.INC); bands applied to losHours with lower bound exclusive and upper bound inclusive',
      inputs: ['IP_LOS_001'],
      inclusions: ['Qualifying discharged IP accounts.'],
      exclusions: ['Open encounters.'],
      thresholds: [
        t('LOS bands', 'thresholds.losBands'),
        t('Percentiles', 'thresholds.losPercentiles')
      ],
      nullHandling: 'No percentiles when the qualifying set is empty.',
      notes: 'Band boundaries are hour-based (24 / 48 / 96) so they agree exactly with IP_GT4_001 and IP_SHORT_001.',
      implementationKey: 'metrics.inpatient.losDistribution'
    })
  ];

  var byId = {};
  for (var i = 0; i < RULES.length; i++) { byId[RULES[i].id] = RULES[i]; }

  UR.calculationRules = {
    RULES: RULES,
    byId: function (id) { return byId[id] || null; },
    ids: function () {
      var out = [];
      for (var j = 0; j < RULES.length; j++) { out.push(RULES[j].id); }
      return out;
    },

    /* Resolve a dotted configuration path such as 'thresholds.obsThresholdHours.0'. */
    resolveThreshold: function (config, path) {
      if (!config || !path) { return undefined; }
      var parts = String(path).split('.');
      var cur = config;
      for (var k = 0; k < parts.length; k++) {
        if (cur === null || cur === undefined) { return undefined; }
        cur = cur[parts[k]];
      }
      return cur;
    },

    /* Human-readable "label = effective value" list for one rule. */
    describeThresholds: function (ruleRec, config) {
      var self = UR.calculationRules;
      var out = [];
      for (var k = 0; k < ruleRec.thresholds.length; k++) {
        var th = ruleRec.thresholds[k];
        var val = self.resolveThreshold(config, th.configPath);
        if (val && typeof val === 'object') { val = JSON.stringify(val); }
        if (val === undefined) { val = '(not set)'; }
        out.push(th.label + ' = ' + val + ' [' + th.configPath + ']' + (th.note ? ' - ' + th.note : ''));
      }
      return out;
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

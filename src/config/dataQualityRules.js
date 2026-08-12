/*
 * dataQualityRules.js - registry of data-quality checks (spec 11.2, Appendix B).
 *
 * Each check has a stable id, a default severity from the spec 11.1 ladder, and
 * a plain-language description. The Data Quality worksheet, the in-app
 * diagnostics list, and the Calculation Reference all read from this registry.
 *
 * Guiding rule (spec 7.2): nothing disappears silently. Every excluded row,
 * unrecognized code, and failed linkage lands on one of these ids.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var S = UR.SEVERITY;
  var C = UR.CLASSIFICATION;

  function dq(id, severity, name, description, effect) {
    return {
      id: id,
      version: '1.0',
      classification: C.DATA_QUALITY,
      severity: severity,
      name: name,
      description: description,
      effect: effect
    };
  }

  var DQ_RULES = [
    /* ------------------------------------------------------------- blocking */
    dq('DQ_MAP_REQUIRED', S.BLOCKING, 'Required field not mapped',
      'A canonical field marked required has no source column assigned.',
      'Processing is refused until the mapping is completed.'),
    dq('DQ_MAP_AMBIGUOUS', S.BLOCKING, 'Ambiguous canonical mapping',
      'Two source columns are mapped to the same canonical field, or a canonical field matched two plausible source columns with equal confidence.',
      'Processing is refused; the user must choose explicitly.'),
    dq('DQ_SERVICE_COLUMN', S.BLOCKING, 'No usable service column',
      'The service-code column is missing or contains no recognizable values.',
      'Service classification is impossible, so no metric can be calculated.'),
    dq('DQ_DATE_COLUMN', S.BLOCKING, 'Unreadable date column',
      'The admission date column could not be parsed for any row.',
      'All duration and period logic is impossible.'),
    dq('DQ_NO_ROWS', S.BLOCKING, 'No data rows',
      'The selected files and worksheets contain no data rows below the header.',
      'There is nothing to process.'),

    /* ---------------------------------------------------------------- error */
    dq('DQ_ADMIT_MISSING', S.ERROR, 'Missing or unparseable admission date',
      'The admission date could not be parsed into a valid datetime.',
      'The row is excluded from all metrics.'),
    dq('DQ_DATE_UNPARSEABLE', S.ERROR, 'Unparseable date or time value',
      'A date or time cell could not be read as an Excel serial value, a recognized text date, or a recognized time.',
      'The affected datetime is unavailable; dependent metrics exclude the row.'),
    dq('DQ_NEG_LOS', S.ERROR, 'Discharge earlier than admission',
      'The discharge datetime precedes the admission datetime by more than the configured overlap tolerance.',
      'The row is excluded from duration, LOS, and occupancy metrics.'),
    dq('DQ_ACCT_CONFLICT', S.ERROR, 'Conflicting duplicate account number',
      'The same account number appears more than once with differing content.',
      'Neither copy is merged. Both are excluded from counts until resolved so nothing is double-counted.'),

    /* -------------------------------------------------------------- warning */
    dq('DQ_SVC_UNKNOWN', S.WARNING, 'Unrecognized service code',
      'A service code was encountered that is not present in the service-code reference table.',
      'The row is excluded from all metrics and listed in the Code Inventory with counts and sample accounts.'),
    dq('DQ_DISCD_UNKNOWN', S.WARNING, 'Unrecognized discharge code',
      'A discharge code was encountered that is not present in the discharge-code reference table.',
      'Length of stay is still calculated; disposition is Unknown and no transition is assumed.'),
    dq('DQ_CODE_RETIRED', S.WARNING, 'Retired reference code in use',
      'A code marked as retired or "do not use" in the hospital reference table appeared on an imported account.',
      'The code is recognized but carries no mapping, so the account groups under Unknown. Either the account was coded with a retired value or the reference table needs the code re-enabled.'),
    dq('DQ_CODE_AMBIGUOUS', S.WARNING, 'Ambiguous reference code',
      'A code did not match any table entry exactly, and more than one entry matched when case or leading zeros were ignored.',
      'No mapping is chosen, because guessing between two payers or two services would silently attribute the account to the wrong one. Correct the code in the export or the reference table.'),
    dq('DQ_CODE_INEXACT', S.INFO, 'Reference code matched inexactly',
      'A code matched a table entry only after ignoring letter case or leading zeros - for example a numeric column that dropped the leading zero from "06".',
      'The mapping was applied and is reported here so the difference between the export and the reference table is visible.'),
    dq('DQ_INS_UNKNOWN', S.WARNING, 'Unmapped insurance code',
      'An insurance code has no payer-category mapping.',
      'The account groups under the Unknown payer category and is excluded from Medicare-specific review rules.'),
    dq('DQ_ADMSRC_UNKNOWN', S.WARNING, 'Unmapped admission-source code',
      'An admission-source value has no mapping.',
      'The value reports as Unknown in the admission-source summary.'),
    dq('DQ_MRN_MISSING', S.WARNING, 'Missing MRN',
      'The patient MRN is blank.',
      'The account cannot participate in transition linkage or readmission logic and forms a single-account episode.'),
    dq('DQ_ACCT_MISSING', S.WARNING, 'Missing account number',
      'The account/encounter number is blank.',
      'A synthetic internal identifier is assigned for traceability; duplicate detection is degraded.'),
    dq('DQ_ROW_DUP', S.WARNING, 'Exact duplicate row',
      'An identical row appeared more than once across the imported files or worksheets.',
      'One copy is retained when de-duplication is enabled; the removal is reported and never silent.'),
    dq('DQ_DISCHARGE_MISSING', S.WARNING, 'Missing discharge datetime on a closed-looking record',
      'A discharge date exists without a usable time, or a discharge time exists without a date.',
      'The record is treated as open and excluded from discharged-stay metrics.'),
    dq('DQ_TIME_MISSING', S.WARNING, 'Missing admission or discharge time',
      'A date was supplied without a companion time value.',
      'Midnight is assumed for that timestamp, which reduces the precision of hour-based metrics. The affected accounts are listed.'),
    dq('DQ_TRANS_MISSING', S.WARNING, 'Missing expected successor',
      'A discharge code implies an internal status change but no matching subsequent account exists.',
      'No link is invented. The episode ends at this account and the transition count excludes it.'),
    dq('DQ_TRANS_AMBIGUOUS', S.WARNING, 'Ambiguous transition candidates',
      'More than one subsequent account plausibly satisfies the expected transition.',
      'No link is made. The accounts remain separate episodes until the data or rules are corrected.'),
    dq('DQ_TRANS_MISMATCH', S.WARNING, 'Transition target service mismatch',
      'A subsequent account was found within the timing tolerance but carries a service other than the expected one.',
      'No automatic link is made; the candidate is reported for review.'),
    dq('DQ_TRANS_GAP', S.WARNING, 'Suspicious transition gap',
      'An accepted transition has a gap larger than the suspicious-gap threshold, though still inside the maximum.',
      'The link is accepted and flagged so the timing can be verified.'),
    dq('DQ_TRANS_OVERLAP', S.WARNING, 'Transition overlap within tolerance',
      'The successor admission begins before the prior discharge, within the configured overlap tolerance.',
      'Linked as Probable rather than Confirmed, and always reported. The overlapping minutes remain in both segments\' durations and occupancy until the source times are corrected.'),
    dq('DQ_TRANS_OVERLAP_EXCEEDED', S.WARNING, 'Coded transition refused: successor overlaps beyond tolerance',
      'A discharge code expects a following account and one of the expected service exists on the same date, but its admission is recorded EARLIER than the prior discharge by more than the overlap tolerance - the registration times contradict the transition.',
      'No link is made and the accounts stay in separate episodes. Both accounts are named: correct the admission/discharge times in the source system, or raise the overlap tolerance in Transition settings, and reprocess.'),
    dq('DQ_TRANS_UNCODED', S.WARNING, 'Possible uncoded transition',
      'A same-MRN service change occurs close in time with no transition discharge code.',
      'No link is made on timing alone. Reported so a coding gap can be corrected at the source.'),
    dq('DQ_OVERLAP_UNEXPLAINED', S.WARNING, 'Overlapping accounts for the same patient',
      'Two accounts for one MRN overlap in time without a configured internal transition explaining it.',
      'Both rows remain in the data; occupancy metrics may double-count until the overlap is resolved.'),
    dq('DQ_LOOKBACK', S.WARNING, 'Insufficient historical lookback',
      'Admissions near the start of the imported range have no visible prior history, so readmission windows cannot be evaluated completely.',
      'Readmission indicators understate the true count for the affected window. The affected date range and account count are reported.'),

    /* ----------------------------------------------------------------- info */
    dq('DQ_SVC_IGNORED', S.INFO, 'Recognized service code configured as ignored',
      'A service code mapped to Ignore was encountered.',
      'The row is excluded from metrics by policy and counted separately from unrecognized codes.'),
    dq('DQ_OPEN', S.INFO, 'Open encounter',
      'No discharge datetime is present, so the stay is still in progress at export time.',
      'Excluded from discharged-stay ALOS and readmission denominators; optionally included in occupancy through the as-of datetime.'),
    dq('DQ_OUT_OF_PERIOD', S.INFO, 'Outside the reporting period',
      'The record falls outside the selected reporting period.',
      'Retained for episode, transition, and readmission context but excluded from period counts.'),
    dq('DQ_ROW_DEDUP', S.INFO, 'Duplicate row removed',
      'An exact duplicate row was collapsed into a single record.',
      'Counted once. The removal is reported here.')
  ];

  var byId = {};
  for (var i = 0; i < DQ_RULES.length; i++) { byId[DQ_RULES[i].id] = DQ_RULES[i]; }

  UR.dataQualityRules = {
    RULES: DQ_RULES,
    byId: function (id) { return byId[id] || null; }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

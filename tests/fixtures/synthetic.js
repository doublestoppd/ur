/*
 * synthetic.js - the minimum synthetic fixture set from spec 16.2 (T01-T17),
 * plus a few supporting records for payer, mortality, and census coverage.
 *
 * Values deliberately mimic a CPSI Ad Hoc export: raw field names as headers,
 * text dates, and 4-digit military times (1432 = 14:32).
 *
 * No real patient data appears here or anywhere in the repository.
 */
'use strict';

var HEADERS = [
  'ipv1_age_years', 'ipv1_num', 'visit_name', 'visit_servicecd_key',
  'ipv1_ad_date', 'ipv1_ad_time', 'ipv1_dis_date', 'ipv1_dis_time',
  'visit_ins', 'ipv1_discd', 'ipv1_origin'
];

/*
 * age, account, name, service, adDate, adTime, disDate, disTime, ins, discd, source
 *
 * The export carries no MRN: patient identity is DERIVED from name + age, so
 * rows meant to be one patient share both, and rows meant to be different
 * patients differ in name (every fixture patient has a distinct name).
 */
var ROWS = [
  /* T01/T02/T03 - the spec 8.4 example: OS -> IP -> SB -> IP, one episode */
  [71, 'A101', 'TEST, ALPHA', 'OS', '08/03/2026', 1015, '08/04/2026', 1432, 'MCR', 'B', 1],
  [71, 'A102', 'TEST, ALPHA', 'IP', '08/04/2026', 1436, '08/08/2026', 1100, 'MCR', 'Q', 1],
  [71, 'A103', 'TEST, ALPHA', 'SB', '08/08/2026', 1104, '08/15/2026', 930, 'MCR', 'V', 1],
  [71, 'A104', 'TEST, ALPHA', 'IP', '08/15/2026', 934, '08/18/2026', 1200, 'MCR', 'H', 1],

  /* T04 - OS -> SB within tolerance */
  [62, 'A201', 'TEST, BRAVO', 'OS', '08/05/2026', 800, '08/06/2026', 900, 'BCBS', 'Q', 2],
  [62, 'A202', 'TEST, BRAVO', 'SB', '08/06/2026', 905, '08/12/2026', 1000, 'BCBS', 'H', 2],

  /* T05 - transition code with no successor */
  [55, 'A301', 'TEST, CHARLIE', 'IP', '08/02/2026', 700, '08/06/2026', 1500, 'MCR', 'Q', 1],

  /* T06 - two plausible successors: must stay unlinked */
  [68, 'A401', 'TEST, DELTA', 'IP', '08/04/2026', 900, '08/05/2026', 1000, 'MA', 'Q', 1],
  [68, 'A402', 'TEST, DELTA', 'SB', '08/05/2026', 1010, '08/09/2026', 1100, 'MA', 'H', 1],
  [68, 'A403', 'TEST, DELTA', 'SB', '08/05/2026', 1020, '08/10/2026', 1100, 'MA', 'H', 1],

  /* T07 - same-day true return: two separate IP episodes, never merged */
  [45, 'A501', 'TEST, ECHO', 'IP', '08/07/2026', 800, '08/07/2026', 1200, 'BCBS', 'H', 3],
  [45, 'A502', 'TEST, ECHO', 'IP', '08/07/2026', 1800, '08/09/2026', 1000, 'BCBS', 'H', 3],

  /* T08 - 30-day readmission at exactly 17 days */
  [77, 'A601', 'TEST, FOXTROT', 'IP', '08/01/2026', 900, '08/03/2026', 1100, 'MCR', 'H', 1],
  [77, 'A602', 'TEST, FOXTROT', 'IP', '08/20/2026', 1100, '08/22/2026', 900, 'MCR', 'H', 1],

  /* T10 - unrecognized service code */
  [33, 'A701', 'TEST, GOLF', 'ZZ', '08/05/2026', 1000, '08/05/2026', 1400, 'BCBS', 'H', 3],

  /* T11 - recognized service code configured as ignored */
  [29, 'A801', 'TEST, HOTEL', 'OP', '08/05/2026', 1000, '08/05/2026', 1600, 'BCBS', 'H', 3],

  /* T12 - unknown discharge code: LOS still calculated, no transition assumed.
     Y is deliberately not in the hospital's discharge-code table. */
  [51, 'A901', 'TEST, INDIA', 'IP', '08/06/2026', 800, '08/09/2026', 1000, 'BCBS', 'Y', 1],

  /* T13 - 121-hour inpatient stay (25 excess hours over the 96-hour target) */
  [83, 'B001', 'TEST, JULIET', 'IP', '08/01/2026', 800, '08/06/2026', 900, 'BCBS', 'H', 1],

  /* T14 - Medicare inpatient crossing a single midnight */
  [79, 'B101', 'TEST, KILO', 'IP', '08/10/2026', 600, '08/11/2026', 1000, 'MCR', 'H', 1],

  /* T15 - Medicare observation at 31 hours: MOON candidate, >24h, not >36h */
  [66, 'B201', 'TEST, LIMA', 'OS', '08/12/2026', 800, '08/13/2026', 1500, 'MCR', 'H', 2],

  /* T16 - open inpatient encounter */
  [58, 'B301', 'TEST, MIKE', 'IP', '08/28/2026', 900, '', '', 'MCR', '', 1],

  /* T17 - exact duplicate account, twice */
  [47, 'B401', 'TEST, NOVEMBER', 'IP', '08/09/2026', 900, '08/10/2026', 900, 'BCBS', 'H', 1],
  [47, 'B401', 'TEST, NOVEMBER', 'IP', '08/09/2026', 900, '08/10/2026', 900, 'BCBS', 'H', 1],

  /* Mortality and payer coverage */
  [91, 'B501', 'TEST, OSCAR', 'IP', '08/14/2026', 700, '08/16/2026', 1300, 'MA', 'E', 1],
  [38, 'B601', 'TEST, PAPA', 'OS', '08/18/2026', 1200, '08/21/2026', 1200, 'SP', 'H', 2],
  [26, 'B701', 'TEST, QUEBEC', 'IP', '08/22/2026', 1500, '08/25/2026', 1000, 'MCD', 'A', 4]
];

function matrix() {
  var out = [HEADERS.slice()];
  for (var i = 0; i < ROWS.length; i++) { out.push(ROWS[i].slice()); }
  return out;
}

/* Build a source table plus its automatic mapping, as the UI would. */
function buildSource(UR, options) {
  var opts = options || {};
  var table = UR.spreadsheetReader.matrixToTable(opts.matrix || matrix());
  var auto = UR.headerMapper.autoMap(table.headers);
  return {
    fileName: opts.fileName || 'cpsi-august-2026.xlsx',
    sheetName: opts.sheetName || 'Sheet1',
    headers: table.headers,
    rows: table.rows,
    headerRowIndex: table.headerRowIndex,
    excelGuardCells: table.excelGuardCells || 0,
    mapping: opts.mapping || auto.mapping,
    auto: auto
  };
}

/*
 * Test configuration: defaults plus the payer and ignored-service mappings the
 * hospital would enter on first use (spec A.3 ships these empty).
 */
function buildConfig(UR) {
  var config = UR.configSchema.defaults();
  var PC = UR.PAYER_CATEGORY;
  config.insuranceCodes = [
    { code: 'MCR', label: 'Medicare fee-for-service', category: PC.MEDICARE_FFS, enabled: true },
    { code: 'MA', label: 'Medicare Advantage plan', category: PC.MEDICARE_ADVANTAGE, enabled: true },
    { code: 'MCD', label: 'Medicaid', category: PC.MEDICAID, enabled: true },
    { code: 'BCBS', label: 'Blue Cross Blue Shield', category: PC.COMMERCIAL, enabled: true },
    { code: 'SP', label: 'Self pay', category: PC.SELF_PAY, enabled: true }
  ];
  config.serviceCodes.push({ code: 'OP', label: 'Outpatient', behavior: UR.SERVICE.IGNORED, enabled: true });
  /* Origin codes as the hospital publishes them, including the unpadded "6". */
  config.admissionSources = [
    { code: '01', label: 'HOME', category: 'Community', enabled: true },
    { code: '02', label: 'CLINIC REFERRAL', category: 'Referral', enabled: true },
    { code: '03', label: 'OTHER HEALTHCARE FAC', category: 'Transfer', enabled: true },
    { code: '04', label: 'EMERGENCY ROOM', category: 'Emergency', enabled: true },
    { code: '6', label: 'OBSERVATION', category: 'Internal status change', enabled: true }
  ];
  return config;
}

/*
 * Run the full pipeline over the fixture set, defaulting to August 2026.
 * Passing an option explicitly as null opts out of the default, so a test can
 * exercise the tool's own period inference.
 */
function run(UR, options) {
  var opts = options || {};
  var config = opts.config || buildConfig(UR);
  var source = buildSource(UR, opts);

  function opt(key, fallback) {
    return Object.prototype.hasOwnProperty.call(opts, key) ? opts[key] : fallback;
  }

  return UR.pipeline.process([source], config, {
    periodStart: opt('periodStart', UR.util.mkDT(2026, 8, 1, 0, 0)),
    periodEnd: opt('periodEnd', UR.util.mkDT(2026, 8, 31, 0, 0)),
    asOf: opt('asOf', UR.util.mkDT(2026, 9, 1, 0, 0)),
    manualObservations: opt('manualObservations', undefined)
  });
}

module.exports = {
  HEADERS: HEADERS,
  ROWS: ROWS,
  matrix: matrix,
  buildSource: buildSource,
  buildConfig: buildConfig,
  run: run
};

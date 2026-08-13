/*
 * The hospital's own reference tables: origin codes, the complete discharge-code
 * list, and the 736-code insurance table.
 *
 * The insurance table is the reason code lookup is case-sensitive: it contains
 * pairs that differ only in case and mean different payers.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var util = UR.util;
var fixtures = require('./fixtures/synthetic');

var defaults = UR.configSchema.defaults();

describe('code lookup is case-sensitive', function () {

  test('the insurance table really does contain case-only collisions', function () {
    var byUpper = {};
    var collisions = [];
    defaults.insuranceCodes.forEach(function (row) {
      var key = util.codeExact(row.code).toUpperCase();
      if (byUpper[key] && byUpper[key] !== util.codeExact(row.code)) {
        collisions.push(byUpper[key] + ' / ' + row.code);
      }
      byUpper[key] = util.codeExact(row.code);
    });
    assert.ok(collisions.length >= 20,
      'the hospital list has ' + collisions.length + ' case-only collisions, so lookup cannot upper-case');
  });

  test('DCg and DCG resolve to different payers', function () {
    var lower = UR.configSchema.insuranceCode(defaults, 'DCg');
    var upper = UR.configSchema.insuranceCode(defaults, 'DCG');
    assert.ok(lower && upper);
    assert.notEqual(lower.label, upper.label);
    assert.includes(lower.label, 'Humana');
    assert.includes(upper.label, 'Lake Village');
  });

  test('an exact match always wins over any fallback', function () {
    var rows = [
      { code: 'ab', label: 'lower' },
      { code: 'AB', label: 'upper' }
    ];
    assert.equal(util.findByCode(rows, 'AB').row.label, 'upper');
    assert.equal(util.findByCode(rows, 'ab').row.label, 'lower');
    assert.equal(util.findByCode(rows, 'AB').match, 'exact');
  });

  test('a case-only near miss is accepted when unambiguous, and reported', function () {
    var rows = [{ code: 'BCBS', label: 'Blue Cross' }];
    var found = util.findByCode(rows, 'bcbs');
    assert.equal(found.row.label, 'Blue Cross');
    assert.equal(found.match, 'case');
  });

  test('a case-only near miss is refused when two entries could match', function () {
    var rows = [
      { code: 'DCg', label: 'Humana' },
      { code: 'DCG', label: 'Lake Village' }
    ];
    var found = util.findByCode(rows, 'dcg');
    assert.equal(found.row, null, 'nothing is chosen');
    assert.equal(found.match, 'ambiguous');
    assert.equal(found.candidates.length, 2);
  });

  test('the ambiguity reaches the diagnostics rather than being silent', function () {
    var config = fixtures.buildConfig(UR);
    config.insuranceCodes = [
      { code: 'DCg', label: 'Humana Womens Clinic', category: UR.PAYER_CATEGORY.COMMERCIAL, enabled: true },
      { code: 'DCG', label: 'Lake Village Rehab', category: UR.PAYER_CATEGORY.OTHER, enabled: true }
    ];
    var matrix = [
      fixtures.HEADERS.slice(),
      [21, 'AMB1', 'CASE, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'dcg', 'H', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    assert.equal(s.encounters[0].payerCategory, UR.PAYER_CATEGORY.UNKNOWN, 'no payer is guessed');
    var d = s.diagnostics.all().filter(function (x) { return x.ruleId === 'DQ_CODE_AMBIGUOUS'; });
    assert.equal(d.length, 1);
    assert.includes(d[0].message, 'will not guess');
  });
});

describe('origin codes', function () {

  test('the seven hospital origin codes ship as defaults', function () {
    var codes = defaults.admissionSources.map(function (r) { return r.code; });
    assert.deepEqual(codes, ['01', '02', '03', '04', '05', '6', '07']);
    var observation = UR.configSchema.admissionSource(defaults, '6');
    assert.equal(observation.label, 'OBSERVATION');
  });

  test('ipv1_origin is the admission-source column, and origin_code still works', function () {
    var auto = UR.headerMapper.autoMap(['ipv1_age_years', 'ipv1_num', 'visit_servicecd_key', 'ipv1_ad_date', 'ipv1_origin']);
    assert.equal(auto.mapping.admissionSource.header, 'ipv1_origin');
    assert.equal(auto.mapping.admissionSource.confidence, UR.headerMapper.CONFIDENCE.EXACT_CPSI,
      'the current raw field name matches exactly');
    var legacy = UR.headerMapper.autoMap(['ipv1_age_years', 'ipv1_num', 'visit_servicecd_key', 'ipv1_ad_date', 'origin_code']);
    assert.equal(legacy.mapping.admissionSource.header, 'origin_code', 'the previous header is still accepted as an alias');
  });

  /*
   * The hospital lists OBSERVATION as "6" while its neighbours carry a leading
   * zero, and a numeric spreadsheet column drops leading zeros from the others.
   * Both directions have to resolve.
   */
  test('a numeric column that lost its leading zero still resolves', function () {
    var home = UR.configSchema.admissionSourceLookup(defaults, 1);
    assert.ok(home.row, 'numeric 1 finds "01"');
    assert.equal(home.row.label, 'HOME');
    assert.equal(home.match, 'numeric');

    var observation = UR.configSchema.admissionSourceLookup(defaults, '06');
    assert.ok(observation.row, '"06" finds the unpadded "6"');
    assert.equal(observation.row.label, 'OBSERVATION');
    assert.equal(observation.match, 'numeric');
  });

  test('an inexact code match is applied but reported', function () {
    var config = fixtures.buildConfig(UR);
    config.admissionSources = [{ code: '01', label: 'HOME', category: 'Community', enabled: true }];
    var matrix = [
      fixtures.HEADERS.slice(),
      [23, 'NUM1', 'NUMERIC, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    assert.equal(s.encounters[0].admissionSourceLabel, 'HOME', 'the mapping is applied');
    var d = s.diagnostics.all().filter(function (x) { return x.ruleId === 'DQ_CODE_INEXACT'; });
    assert.equal(d.length, 1, 'and the difference is reported');
    assert.includes(d[0].message, 'leading zero');
    assert.equal(d[0].severity, UR.SEVERITY.INFO);
  });
});

describe('discharge codes', function () {

  test('the complete hospital table ships, with the UB-04 status in the label', function () {
    assert.equal(defaults.dischargeCodes.length, 24);
    assert.includes(UR.configSchema.dischargeCode(defaults, 'H').label, '01 DISCHARGE TO HOME');
    assert.includes(UR.configSchema.dischargeCode(defaults, 'N').label, '03 DIS/TRAN TO SKILLED NURSING');
  });

  test('code W is the catch-all outward transfer, a true discharge', function () {
    var w = UR.configSchema.dischargeCode(defaults, 'W');
    assert.includes(w.label, '70 D/C TRANS TO OTHER HEALTHCARE FAC NOT DEFINED ELSEWHERE');
    assert.equal(w.category, 'Other healthcare facility');
    assert.equal(w.transitionTo, null, 'no internal successor expected');
    assert.ok(w.enabled);
  });

  test('all four expired codes count as deaths', function () {
    ['E', 'F', 'G', 'J'].forEach(function (code) {
      assert.equal(UR.configSchema.dischargeCode(defaults, code).category, defaults.deathCategory,
        'code ' + code + ' is a death');
    });
    var matrix = [
      fixtures.HEADERS.slice(),
      [25, 'D-E', 'A, TEST', 'IP', '08/02/2026', 600, '08/03/2026', 600, 'BCBS', 'E', '01'],
      [27, 'D-F', 'B, TEST', 'IP', '08/04/2026', 600, '08/05/2026', 600, 'BCBS', 'F', '01'],
      [29, 'D-G', 'C, TEST', 'IP', '08/06/2026', 600, '08/07/2026', 600, 'BCBS', 'G', '01'],
      [31, 'D-J', 'D, TEST', 'IP', '08/08/2026', 600, '08/09/2026', 600, 'BCBS', 'J', '01'],
      [33, 'D-H', 'E, TEST', 'IP', '08/10/2026', 600, '08/11/2026', 600, 'BCBS', 'H', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.metrics.payer.DEATH_001.value, 4, 'four death codes, one live discharge');
  });

  test('only B, Q, V and Z imply an internal status change', function () {
    var transitional = defaults.dischargeCodes
      .filter(function (r) { return r.transitionTo; })
      .map(function (r) { return r.code; })
      .sort();
    assert.deepEqual(transitional, ['B', 'Q', 'V', 'Z']);
  });

  test('Z expects a following observation account without judging Code 44', function () {
    var z = UR.configSchema.dischargeCode(defaults, 'Z');
    assert.equal(z.transitionTo, UR.SERVICE.OS);
    assert.includes(z.note, 'Condition Code 44');

    var matrix = [
      fixtures.HEADERS.slice(),
      [35, 'Z1', 'Z, TEST', 'IP', '08/10/2026', 600, '08/10/2026', 1200, 'BCBS', 'Z', '01'],
      [35, 'Z2', 'Z, TEST', 'OS', '08/10/2026', 1210, '08/11/2026', 1000, 'BCBS', 'H', '6']
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.transitions[0].confidence, UR.LINK_CONFIDENCE.CONFIRMED);
    assert.equal(s.episodes.length, 1, 'the two accounts are one continuous episode');
    assert.equal(s.episodes[0].serviceSequence.join(' -> '), 'IP -> OS');
  });

  test('an outward transfer to another CAH is reported, never linked backwards', function () {
    /* V on an inpatient account means what the code says: an outward transfer. */
    var matrix = [
      fixtures.HEADERS.slice(),
      [37, 'V1', 'V, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'V', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters[0].transitionTo, null, 'no successor is expected from an IP account');
    assert.equal(s.transitions.length, 0);
  });
});

describe('insurance table', function () {

  test('every row is well formed and uses a known payer category', function () {
    assert.ok(defaults.insuranceCodes.length > 700);
    defaults.insuranceCodes.forEach(function (row) {
      assert.ok(util.codeExact(row.code) !== '', 'a code is present');
      assert.ok(util.contains(UR.PAYER_CATEGORY_LIST, row.category), row.code + ' category: ' + row.category);
      assert.ok(typeof row.enabled === 'boolean', row.code + ' enabled flag');
    });
  });

  test('the shipped table passes configuration validation', function () {
    var result = UR.configSchema.validate(JSON.parse(UR.configSchema.toJSON(defaults, '')));
    assert.ok(result.ok, (result.errors || []).join(' '));
    assert.equal(result.config.insuranceCodes.length, defaults.insuranceCodes.length);
  });

  test('representative codes carry the hospital\'s own category', function () {
    var cases = [
      ['M', UR.PAYER_CATEGORY.MEDICARE_FFS, 'Medicare'],
      ['MC9', UR.PAYER_CATEGORY.MEDICARE_FFS, 'Medicare'],
      ['MP1', UR.PAYER_CATEGORY.MEDICARE_FFS, 'Palmetto GBA'],
      ['M7', UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE, 'Humana Medicare Advantage'],
      ['MQ', UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE, 'Blue Medicare HMO'],
      ['X', UR.PAYER_CATEGORY.MEDICAID, 'Medicaid'],
      ['X7', UR.PAYER_CATEGORY.MEDICAID, 'CareSource PASSE'],
      ['B2', UR.PAYER_CATEGORY.COMMERCIAL, 'Blue Cross'],
      ['D5', UR.PAYER_CATEGORY.COMMERCIAL, 'Humana commercial'],
      ['D6', UR.PAYER_CATEGORY.COMMERCIAL, 'Aetna commercial'],
      ['P', UR.PAYER_CATEGORY.SELF_PAY, 'Private Pay'],
      ['W', UR.PAYER_CATEGORY.OTHER, "Workers' Compensation"],
      ['S', UR.PAYER_CATEGORY.OTHER, 'TRICARE / CHAMPUS'],
      ['S1', UR.PAYER_CATEGORY.OTHER, 'VA Community Care']
    ];
    cases.forEach(function (c) {
      var row = UR.configSchema.insuranceCode(defaults, c[0]);
      assert.ok(row, 'code ' + c[0] + ' is present');
      assert.equal(row.category, c[1], c[0] + ' (' + c[2] + ') category');
    });
  });

  /*
   * The hospital files Medicare supplement plans under Commercial/Managed Care,
   * not under Medicare. That is deliberate and it matters: a Medigap account is
   * therefore NOT on the IMM or MOON lists. Asserting it here so the decision
   * survives any future tidy-up of the payer table.
   */
  test('Medicare supplement plans are Commercial, and stay off the Medicare lists', function () {
    ['D4', 'D4R', 'DB4', 'DS', 'DCE'].forEach(function (code) {
      var row = UR.configSchema.insuranceCode(defaults, code);
      assert.ok(row, code + ' is present');
      assert.equal(row.category, UR.PAYER_CATEGORY.COMMERCIAL,
        code + ' (' + row.label + ') is Commercial per the hospital mapping');
    });

    var matrix = [
      fixtures.HEADERS.slice(),
      [39, 'GAP1', 'MEDIGAP, TEST', 'IP', '08/10/2026', 600, '08/11/2026', 1000, 'D4', 'H', '04']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: UR.configSchema.defaults() });
    assert.equal(s.encounters[0].payerCategory, UR.PAYER_CATEGORY.COMMERCIAL);
    assert.equal(s.reviewQueue.counts.RQ_IMM, 0, 'a Medigap inpatient is not an IMM candidate');
    assert.equal(s.metrics.inpatient.IP_2MN_001.value, 0, 'nor a two-midnight review candidate');
  });

  test('the Medicare sets are small and specific', function () {
    var ffs = defaults.insuranceCodes.filter(function (r) { return r.category === UR.PAYER_CATEGORY.MEDICARE_FFS; });
    var ma = defaults.insuranceCodes.filter(function (r) { return r.category === UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE; });
    assert.equal(ffs.length, 20, 'only true Medicare and its administrative contractor');
    assert.equal(ma.length, 103);
    ffs.forEach(function (row) {
      assert.ok(/Medicare|Palmetto/.test(row.label), row.code + ' (' + row.label + ') looks like Medicare');
      assert.ok(row.label.indexOf('Supplement') < 0, row.code + ' is not a supplement plan');
      assert.ok(row.label.indexOf('Advantage') < 0, row.code + ' is not an Advantage plan');
    });
  });

  test('categories are the hospital\'s, not inferred by the tool', function () {
    var noted = defaults.insuranceCodes.filter(function (r) { return r.note; });
    assert.equal(noted.length, 0,
      'no row needs a "verify this guess" note, because the categories were supplied');
  });

  test('inactive codes keep the hospital category but ship disabled', function () {
    var retired = defaults.insuranceCodes.filter(function (r) { return r.enabled === false; });
    assert.equal(retired.length, 163, 'the codes the hospital marks Do Not Use / Inactive');
    retired.forEach(function (row) {
      assert.includes(row.label.toLowerCase(), 'do not use');
      assert.equal(row.category, UR.PAYER_CATEGORY.OTHER,
        'the hospital category is preserved, so re-enabling the row restores the source mapping');
    });
  });

  test('a retired code on a current account is reported as retired, not unknown', function () {
    var config = UR.configSchema.defaults();
    var matrix = [
      fixtures.HEADERS.slice(),
      [41, 'RET1', 'RETIRED, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'MEC', 'H', '01']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    assert.equal(s.encounters[0].payerCategory, UR.PAYER_CATEGORY.UNKNOWN);
    var retired = s.diagnostics.all().filter(function (x) { return x.ruleId === 'DQ_CODE_RETIRED'; });
    assert.equal(retired.length, 1);
    assert.includes(retired[0].message, 'marked retired');
    var unknown = s.diagnostics.all().filter(function (x) { return x.ruleId === 'DQ_INS_UNKNOWN'; });
    assert.equal(unknown.length, 0, 'it is not also reported as never-mapped');
  });

  test('the shipped tables drive the Medicare review lists end to end', function () {
    var config = UR.configSchema.defaults();
    var matrix = [
      fixtures.HEADERS.slice(),
      /* M = MEDICARE IP, M7 = HUMANA MCR ADV IP, B2 = BLUE CROSS -IP */
      [43, 'MC1', 'FFS, TEST', 'IP', '08/10/2026', 600, '08/11/2026', 1000, 'M', 'H', '04'],
      [45, 'MA1', 'ADV, TEST', 'IP', '08/12/2026', 600, '08/13/2026', 1000, 'M7', 'H', '04'],
      [47, 'CM1', 'COM, TEST', 'IP', '08/14/2026', 600, '08/15/2026', 1000, 'B2', 'H', '04'],
      [49, 'MO1', 'OBS, TEST', 'OS', '08/16/2026', 600, '08/18/2026', 600, 'MB', 'H', '04']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    var imm = s.reviewQueue.rows.filter(function (r) { return r.ruleId === 'RQ_IMM'; });
    assert.equal(imm.length, 2, 'the Medicare FFS and Medicare Advantage inpatients, not the commercial one');
    var moon = s.reviewQueue.rows.filter(function (r) { return r.ruleId === 'RQ_MOON'; });
    assert.equal(moon.length, 1, 'the 48-hour Medicare observation stay');
    assert.equal(moon[0].account, 'MO1');
    assert.equal(s.metrics.inpatient.IP_2MN_001.value, 2, 'both Medicare inpatients cross one midnight');
  });

  test('the code inventory reports the shipped mappings against real data', function () {
    var config = UR.configSchema.defaults();
    var matrix = [
      fixtures.HEADERS.slice(),
      [51, 'INV1', 'INV, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'M', 'H', '04'],
      [53, 'INV2', 'INV, TEST', 'IP', '08/13/2026', 600, '08/15/2026', 600, 'NOPE', 'H', '04']
    ];
    var s = fixtures.run(UR, { matrix: matrix, config: config });
    var insurance = s.codeInventory.filter(function (sec) { return sec.type === 'Insurance code'; })[0];
    var mapped = insurance.rows.filter(function (r) { return r.value === 'M'; })[0];
    var unmapped = insurance.rows.filter(function (r) { return r.value === 'NOPE'; })[0];
    assert.equal(mapped.status, UR.codeInventory.STATUS.USED);
    assert.includes(mapped.behavior, 'Medicare FFS');
    assert.equal(unmapped.status, UR.codeInventory.STATUS.UNRECOGNIZED);
  });
});

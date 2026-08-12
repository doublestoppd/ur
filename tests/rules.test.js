/*
 * Registry integrity and configuration handling (spec 7, 14, 15.2, Appendix B).
 *
 * The registries are the contract between the engine, the UI, and the exported
 * workbook. These tests keep that contract honest: every rule the spec names
 * exists, carries complete metadata, resolves its thresholds against live
 * configuration, and - for the regulatory ones - states its limits.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

var SPEC_CALCULATION_RULES = [
  'IP_ADM_001', 'IP_LOS_001', 'IP_ALOS_001', 'IP_MEDLOS_001', 'IP_TARGET_001',
  'IP_GT4_001', 'IP_EXCESS_001', 'IP_SHORT_001', 'IP_2MN_001',
  'OS_ADM_001', 'OS_LOS_001', 'OS_ALOS_001', 'OS_24_001', 'OS_36_001', 'OS_48_001',
  'OSIP_001', 'OSIP_RATE_001', 'OSIP_TIME_001',
  'SB_ADM_001', 'SB_LOS_001', 'SB_ALOS_001', 'IPSB_001', 'OSSB_001', 'SBIP_001',
  'PD_EQ_001', 'PD_MN_001', 'ADC_EQ_001', 'ADC_MN_001',
  'READMIT_7_001', 'READMIT_30_001', 'READMIT_MCR_001'
];

var SPEC_REVIEW_RULES = [
  'RQ_IP_GT4', 'RQ_OS_24', 'RQ_OS_36', 'RQ_OS_48', 'RQ_OS_IP', 'RQ_IP_SB', 'RQ_SB_IP',
  'RQ_SHORT_MCR', 'RQ_1DAY', 'RQ_READMIT_7', 'RQ_READMIT_30', 'RQ_IMM', 'RQ_MOON',
  'RQ_TRANSITION', 'RQ_DATA'
];

describe('calculation rule registry', function () {

  test('every rule named in the specification is present', function () {
    SPEC_CALCULATION_RULES.forEach(function (id) {
      assert.ok(UR.calculationRules.byId(id), 'missing rule ' + id);
    });
  });

  test('every rule carries the Appendix B metadata', function () {
    UR.calculationRules.RULES.forEach(function (r) {
      assert.ok(r.id, 'rule id');
      assert.ok(r.version, r.id + ' version');
      assert.ok(r.name, r.id + ' name');
      assert.ok(r.classification, r.id + ' classification');
      assert.ok(r.definition && r.definition.length > 20, r.id + ' definition');
      assert.ok(r.formula && r.formula.length > 5, r.id + ' formula');
      assert.ok(r.inputs.length > 0, r.id + ' inputs');
      assert.ok(r.inclusions.length > 0, r.id + ' inclusions');
      assert.ok(r.nullHandling, r.id + ' null/open handling');
      assert.ok(r.sourceRefs.length > 0, r.id + ' source references');
      assert.ok(r.implementationKey, r.id + ' implementation key');
    });
  });

  test('rule identifiers are unique', function () {
    var seen = {};
    UR.calculationRules.RULES.concat(UR.reviewRules.RULES).concat(UR.dataQualityRules.RULES)
      .forEach(function (r) {
        assert.notOk(seen[r.id], 'duplicate rule id ' + r.id);
        seen[r.id] = true;
      });
  });

  test('classifications come from the fixed vocabulary', function () {
    var allowed = [UR.CLASSIFICATION.REGULATORY, UR.CLASSIFICATION.OPERATIONAL,
      UR.CLASSIFICATION.HOSPITAL, UR.CLASSIFICATION.DATA_QUALITY];
    UR.calculationRules.RULES.concat(UR.reviewRules.RULES).forEach(function (r) {
      assert.ok(UR.util.contains(allowed, r.classification), r.id + ' classification: ' + r.classification);
    });
  });

  test('every source reference resolves to a documented citation', function () {
    UR.calculationRules.RULES.concat(UR.reviewRules.RULES).forEach(function (r) {
      r.sourceRefs.forEach(function (ref) {
        assert.ok(UR.referenceById(ref), r.id + ' cites unknown reference ' + ref);
      });
    });
  });

  test('every reference R1-R9 from the specification is present with a URL', function () {
    ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].forEach(function (id) {
      var ref = UR.referenceById(id);
      assert.ok(ref, 'missing reference ' + id);
      assert.includes(ref.url, 'http', id + ' has a source URL');
    });
  });

  test('thresholds resolve against live configuration, not copied numbers', function () {
    var config = fixtures.buildConfig(UR);
    var rule = UR.calculationRules.byId('IP_GT4_001');
    var described = UR.calculationRules.describeThresholds(rule, config);
    assert.includes(described.join(' '), '= 96');

    config.thresholds.acuteTargetHours = 120;
    var updated = UR.calculationRules.describeThresholds(rule, config);
    assert.includes(updated.join(' '), '= 120', 'the reference follows the configuration');
  });

  test('indexed threshold paths resolve', function () {
    var config = fixtures.buildConfig(UR);
    assert.equal(UR.calculationRules.resolveThreshold(config, 'thresholds.obsThresholdHours.1'), 36);
    assert.equal(UR.calculationRules.resolveThreshold(config, 'thresholds.readmissionWindowDays.0'), 7);
    assert.equal(UR.calculationRules.resolveThreshold(config, 'processing.losBasis'), 'discharge');
  });

  test('regulatory rules state their limits', function () {
    var regulatory = UR.calculationRules.RULES.concat(UR.reviewRules.RULES).filter(function (r) {
      return r.classification === UR.CLASSIFICATION.REGULATORY;
    });
    assert.ok(regulatory.length >= 3, 'the regulatory set is non-empty');
    regulatory.forEach(function (r) {
      assert.ok(r.notes && r.notes.length > 40, r.id + ' must carry a limitation note');
    });
    assert.includes(UR.reviewRules.byId('RQ_IMM').notes, 'NOT PROOF OF DELIVERY');
    assert.includes(UR.reviewRules.byId('RQ_MOON').notes, 'NOT PROOF OF DELIVERY');
    assert.includes(UR.reviewRules.byId('RQ_SHORT_MCR').notes, 'DO NOT LABEL THESE INAPPROPRIATE');
  });

  test('readmission rules refuse the CMS label', function () {
    ['READMIT_7_001', 'READMIT_30_001', 'READMIT_MCR_001'].forEach(function (id) {
      var r = UR.calculationRules.byId(id);
      assert.includes(r.notes, 'INTERNAL OPERATIONAL INDICATOR');
      assert.includes(r.notes, 'CMS');
    });
  });

  test('the paired patient-day methods say they are unvalidated', function () {
    ['PD_EQ_001', 'PD_MN_001', 'ADC_EQ_001', 'ADC_MN_001'].forEach(function (id) {
      assert.includes(UR.calculationRules.byId(id).notes, 'PAIRED METHOD');
    });
  });
});

describe('review rule registry', function () {

  test('every review trigger named in the specification is present', function () {
    SPEC_REVIEW_RULES.forEach(function (id) {
      assert.ok(UR.reviewRules.byId(id), 'missing review rule ' + id);
    });
  });

  test('every review trigger has a generator', function () {
    UR.reviewRules.ids().forEach(function (id) {
      assert.ok(typeof UR.reviewQueue.generators[id] === 'function', 'no generator for ' + id);
    });
  });

  test('no review trigger claims a clinical determination', function () {
    var forbidden = ['medically necessary', 'inappropriate stay', 'denial is', 'non-compliant', 'avoidable day'];
    UR.reviewRules.RULES.forEach(function (r) {
      var text = (r.definition + ' ' + r.trigger).toLowerCase();
      forbidden.forEach(function (phrase) {
        assert.ok(text.indexOf(phrase) < 0, r.id + ' must not assert "' + phrase + '"');
      });
    });
  });
});

describe('configuration', function () {

  test('defaults ship with the hospital reference tables', function () {
    var config = UR.configSchema.defaults();
    var services = config.serviceCodes.map(function (r) { return r.code; });
    assert.deepEqual(services, ['IP', 'OS', 'SB']);

    var codes = config.dischargeCodes.map(function (r) { return r.code; });
    ['A', 'B', 'C', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'X', 'Z']
      .forEach(function (c) {
        assert.ok(codes.indexOf(c) >= 0, 'missing discharge code ' + c);
      });
    assert.equal(codes.length, 23, 'the complete hospital discharge-code table');
    assert.ok(config.insuranceCodes.length > 700, 'the hospital insurance table ships with the application');
    assert.equal(config.admissionSources.length, 7, 'the seven origin codes');
    assert.equal(config.transition.maxGapMinutes, 120);
    /* Raised from the spec's 15 after live data showed registration entering
     * the successor admission ~45 minutes before the prior discharge on a
     * genuine SB -> IP transition (spec B.1; TRANS_001 v1.1). */
    assert.equal(config.transition.overlapToleranceMinutes, 60);
    assert.equal(config.transition.requireSameCalendarDate, true);
    assert.equal(config.thresholds.acuteTargetHours, 96);
    assert.deepEqual(config.thresholds.obsThresholdHours, [24, 36, 48]);
    assert.deepEqual(config.thresholds.readmissionWindowDays, [7, 30]);
  });

  test('code V keeps its published meaning alongside the local rule', function () {
    var v = UR.configSchema.dischargeCode(UR.configSchema.defaults(), 'V');
    assert.includes(v.label, 'CRITICAL ACCESS HOSPITAL');
    assert.includes(v.note, 'HOSPITAL-SPECIFIC');
    assert.deepEqual(v.transitionFrom, ['SB']);
  });

  test('export and import round-trip a configuration', function () {
    var config = fixtures.buildConfig(UR);
    config.thresholds.acuteTargetHours = 100;
    UR.configSchema.bumpVersion(config);
    var json = UR.configSchema.toJSON(config, '2026-08-11T00:00:00Z');
    var parsed = JSON.parse(json);
    var result = UR.configSchema.validate(parsed);
    assert.ok(result.ok, (result.errors || []).join(' '));
    assert.equal(result.config.thresholds.acuteTargetHours, 100);
    assert.equal(result.config.insuranceCodes.length, config.insuranceCodes.length);
    assert.equal(result.config.configVersion, config.configVersion);
  });

  test('an exported configuration never carries patient data', function () {
    var config = fixtures.buildConfig(UR);
    config.encounters = [{ mrn: '1001', name: 'TEST, ALPHA' }];
    config.secretNote = 'should not be exported';
    var parsed = JSON.parse(UR.configSchema.toJSON(config, ''));
    assert.equal(parsed.encounters, undefined, 'encounter data is stripped');
    assert.equal(parsed.secretNote, undefined, 'unknown keys are stripped');
    Object.keys(parsed).forEach(function (k) {
      assert.ok(UR.util.contains(UR.configSchema.ALLOWED_KEYS.concat(['appVersion']), k), 'unexpected exported key: ' + k);
    });
  });

  test('an imported file containing patient data is refused that section', function () {
    var payload = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    payload.encounters = [{ mrn: '1001' }];
    var result = UR.configSchema.validate(payload);
    assert.ok(result.ok, 'the configuration part still loads');
    assert.equal(result.config.encounters, undefined);
    assert.includes(result.warnings.join(' '), 'never imports patient data');
  });

  test('invalid values are rejected with a readable message', function () {
    var bad = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    bad.serviceCodes.push({ code: 'XX', behavior: 'NONSENSE', enabled: true });
    var result = UR.configSchema.validate(bad);
    assert.notOk(result.ok);
    assert.includes(result.errors.join(' '), 'unrecognized behavior');

    var negative = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    negative.transition.maxGapMinutes = -5;
    assert.notOk(UR.configSchema.validate(negative).ok);

    var basis = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    basis.processing.losBasis = 'sideways';
    assert.notOk(UR.configSchema.validate(basis).ok);
  });

  test('a newer schema version is refused rather than half-applied', function () {
    var future = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    future.schemaVersion = UR.CONFIG_SCHEMA_VERSION + 1;
    var result = UR.configSchema.validate(future);
    assert.notOk(result.ok);
    assert.includes(result.errors.join(' '), 'newer version');
  });

  test('a different ruleset version warns without blocking', function () {
    var older = JSON.parse(UR.configSchema.toJSON(fixtures.buildConfig(UR), ''));
    older.rulesetVersion = '0.9';
    var result = UR.configSchema.validate(older);
    assert.ok(result.ok);
    assert.includes(result.warnings.join(' '), 'Re-validate');
  });

  test('browser persistence stores only non-PHI settings', function () {
    var store = (function () {
      var data = {};
      return {
        setItem: function (k, v) { data[k] = String(v); },
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        removeItem: function (k) { delete data[k]; },
        raw: function () { return data; }
      };
    })();

    var config = fixtures.buildConfig(UR);
    config.encounters = [{ mrn: '1001', name: 'TEST, ALPHA' }];
    assert.ok(UR.configSchema.save(config, store).ok);
    var stored = store.raw()[UR.configSchema.STORAGE_KEY];
    assert.ok(stored.indexOf('1001') < 0, 'no MRN reaches storage');
    assert.ok(stored.indexOf('ALPHA') < 0, 'no patient name reaches storage');

    var loaded = UR.configSchema.load(store);
    assert.ok(loaded.ok);
    assert.equal(loaded.config.insuranceCodes.length, config.insuranceCodes.length);
    assert.ok(UR.configSchema.clear(store));
    assert.notOk(UR.configSchema.load(store).ok);
  });

  test('changing a threshold changes the metric, not the code', function () {
    var config = fixtures.buildConfig(UR);
    config.thresholds.acuteTargetHours = 48;
    var s = fixtures.run(UR, { config: config });
    var baseline = fixtures.run(UR);
    assert.ok(s.metrics.inpatient.IP_GT4_001.value > baseline.metrics.inpatient.IP_GT4_001.value,
      'a lower target flags more long stays');
  });

  test('changing the transition tolerance changes linkage, not the code', function () {
    var config = fixtures.buildConfig(UR);
    config.transition.maxGapMinutes = 1;
    var s = fixtures.run(UR, { config: config });
    assert.equal(s.metrics.observation.OSIP_001.value, 0, 'a 4-minute gap no longer links at a 1-minute tolerance');
  });
});

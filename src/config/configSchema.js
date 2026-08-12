/*
 * configSchema.js - configuration validation, versioning, and persistence
 * (spec 14).
 *
 * The canonical persistence mechanism is an explicit JSON export/import,
 * because file:// browser storage is unreliable across workstation rebuilds.
 * Browser-local persistence is a best-effort convenience on top of it.
 *
 * PHI RULE (spec 4.3): only reference mappings and thresholds are ever written
 * to storage. This module refuses to persist any object carrying encounter
 * data, and guards that with an explicit key whitelist.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  var STORAGE_KEY = 'ur-compiler.config.v1';

  /* The only keys ever written to storage or an export file. Anything else in a
   * configuration object is dropped rather than persisted. */
  var ALLOWED_KEYS = [
    'configVersion', 'schemaVersion', 'rulesetVersion', 'serviceCodes',
    'dischargeCodes', 'insuranceCodes', 'admissionSources', 'transition',
    'thresholds', 'processing', 'deathCategory', 'label', 'savedAt'
  ];

  function pickAllowed(config) {
    var out = {};
    for (var i = 0; i < ALLOWED_KEYS.length; i++) {
      var k = ALLOWED_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(config, k)) {
        out[k] = util.clone(config[k]);
      }
    }
    return out;
  }

  function isPlainArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  var configSchema = {
    STORAGE_KEY: STORAGE_KEY,
    ALLOWED_KEYS: ALLOWED_KEYS,

    /* Factory defaults (spec 14: "Reset"). */
    defaults: function () {
      return UR.defaultMappings.build();
    },

    /*
     * Validate an imported configuration. Returns
     * { ok, errors[], warnings[], config } where config is the normalized value
     * when ok is true. Never throws on user input.
     */
    validate: function (raw) {
      var errors = [];
      var warnings = [];

      if (!raw || typeof raw !== 'object' || isPlainArray(raw)) {
        return { ok: false, errors: ['The file does not contain a configuration object.'], warnings: [], config: null };
      }

      if (raw.schemaVersion === undefined) {
        warnings.push('No schemaVersion present; assuming version ' + UR.CONFIG_SCHEMA_VERSION + '.');
      } else if (typeof raw.schemaVersion !== 'number') {
        errors.push('schemaVersion must be a number.');
      } else if (raw.schemaVersion > UR.CONFIG_SCHEMA_VERSION) {
        errors.push('This configuration was written by a newer version of the application (schema ' +
          raw.schemaVersion + ' vs supported ' + UR.CONFIG_SCHEMA_VERSION + '). Upgrade the application before importing it.');
      }

      if (raw.rulesetVersion && raw.rulesetVersion !== UR.RULESET_VERSION) {
        warnings.push('The configuration was saved against calculation ruleset ' + raw.rulesetVersion +
          '; this build uses ' + UR.RULESET_VERSION + '. Re-validate thresholds and rule definitions before relying on the output.');
      }

      /* Start from defaults so a partial file still yields a complete config. */
      var base = configSchema.defaults();
      var cfg = base;

      function takeArray(key, validator) {
        if (raw[key] === undefined) {
          warnings.push('No ' + key + ' in the file; built-in defaults retained.');
          return;
        }
        if (!isPlainArray(raw[key])) {
          errors.push(key + ' must be an array.');
          return;
        }
        var rows = [];
        for (var i = 0; i < raw[key].length; i++) {
          var row = raw[key][i];
          if (!row || typeof row !== 'object') {
            errors.push(key + '[' + i + '] is not an object.');
            continue;
          }
          var msg = validator(row, i);
          if (msg) { errors.push(msg); continue; }
          rows.push(row);
        }
        cfg[key] = rows;
      }

      takeArray('serviceCodes', function (row, i) {
        if (!row.code) { return 'serviceCodes[' + i + '] has no code.'; }
        if (!util.contains([UR.SERVICE.IP, UR.SERVICE.OS, UR.SERVICE.SB, UR.SERVICE.IGNORED], row.behavior)) {
          return 'serviceCodes[' + i + '] (' + row.code + ') has an unrecognized behavior "' + row.behavior + '".';
        }
        return null;
      });

      takeArray('dischargeCodes', function (row, i) {
        if (!row.code) { return 'dischargeCodes[' + i + '] has no code.'; }
        if (row.transitionTo && !util.contains(UR.INCLUDED_SERVICES, row.transitionTo)) {
          return 'dischargeCodes[' + i + '] (' + row.code + ') targets an unrecognized service "' + row.transitionTo + '".';
        }
        return null;
      });

      takeArray('insuranceCodes', function (row, i) {
        if (row.code === undefined || row.code === null || row.code === '') { return 'insuranceCodes[' + i + '] has no code.'; }
        if (row.category && !util.contains(UR.PAYER_CATEGORY_LIST, row.category)) {
          return 'insuranceCodes[' + i + '] (' + row.code + ') has an unrecognized payer category "' + row.category + '".';
        }
        return null;
      });

      takeArray('admissionSources', function (row, i) {
        if (row.code === undefined || row.code === null || row.code === '') { return 'admissionSources[' + i + '] has no code.'; }
        return null;
      });

      /* Scalar setting groups: merge over defaults, type-check known numbers. */
      function mergeSettings(key, numericFields) {
        if (raw[key] === undefined) { return; }
        if (typeof raw[key] !== 'object' || isPlainArray(raw[key])) {
          errors.push(key + ' must be an object.');
          return;
        }
        for (var f in raw[key]) {
          if (!Object.prototype.hasOwnProperty.call(raw[key], f)) { continue; }
          if (util.contains(numericFields, f)) {
            var n = Number(raw[key][f]);
            if (isNaN(n)) { errors.push(key + '.' + f + ' must be a number.'); continue; }
            if (n < 0) { errors.push(key + '.' + f + ' must not be negative.'); continue; }
            cfg[key][f] = n;
          } else {
            cfg[key][f] = util.clone(raw[key][f]);
          }
        }
      }

      mergeSettings('transition', ['maxGapMinutes', 'overlapToleranceMinutes', 'suspiciousGapMinutes', 'uncodedTransitionWindowMinutes']);
      mergeSettings('thresholds', ['acuteTargetHours', 'acuteTargetDays', 'oneDayStayHours', 'shortStayMidnights', 'moonThresholdHours']);
      mergeSettings('processing', []);

      if (cfg.processing && !util.contains(['discharge', 'admission'], cfg.processing.losBasis)) {
        errors.push('processing.losBasis must be "discharge" or "admission".');
      }

      /*
       * The rule registry defines a fixed number of cohorts: three observation
       * thresholds (OS_24_001 / OS_36_001 / OS_48_001) and two readmission
       * windows (READMIT_7_001 / READMIT_30_001). The VALUES are configurable;
       * the COUNT is structural, because each one is a separately versioned and
       * separately documented rule. Accepting a different count would leave
       * rules with no threshold to read.
       */
      function checkNumericList(path, list, count, unit, dependents) {
        if (!isPlainArray(list)) {
          errors.push(path + ' must be an array of ' + unit + '.');
          return;
        }
        if (list.length !== count) {
          errors.push(path + ' must contain exactly ' + (count === 3 ? 'three' : 'two') + ' values, one for each of ' +
            dependents + '. Change the values, not how many there are; adding a cohort is a source-code change ' +
            'that also adds a rule to the registry.');
          return;
        }
        for (var i = 0; i < list.length; i++) {
          var n = Number(list[i]);
          if (isNaN(n) || n <= 0) {
            errors.push(path + '[' + i + '] must be a positive number of ' + unit + '.');
            return;
          }
          if (i > 0 && n <= Number(list[i - 1])) {
            errors.push(path + ' must be in ascending order; ' + list[i - 1] + ' is followed by ' + list[i] + '.');
            return;
          }
          list[i] = n;
        }
      }

      if (cfg.thresholds) {
        checkNumericList('thresholds.obsThresholdHours', cfg.thresholds.obsThresholdHours, 3, 'hours',
          'OS_24_001, OS_36_001, and OS_48_001');
        checkNumericList('thresholds.readmissionWindowDays', cfg.thresholds.readmissionWindowDays, 2, 'days',
          'READMIT_7_001 and READMIT_30_001');
      }

      if (cfg.processing) {
        var share = cfg.processing.periodInferenceShare;
        if (typeof share !== 'number' || isNaN(share) || share <= 0 || share > 1) {
          errors.push('processing.periodInferenceShare must be a fraction greater than 0 and at most 1. ' +
            'It is the share of the busiest month\'s activity a neighbouring month must carry to join the inferred reporting period.');
        }
      }

      /*
       * Two rows with the same code make a lookup non-deterministic, and codes
       * that differ only in case are legitimate here - so the check is exact.
       */
      ['serviceCodes', 'dischargeCodes', 'insuranceCodes', 'admissionSources'].forEach(function (key) {
        var seen = {};
        var list = cfg[key] || [];
        for (var i = 0; i < list.length; i++) {
          var code = util.codeExact(list[i].code);
          if (code === '') { continue; }
          if (seen[code]) {
            errors.push(key + ' contains the code "' + code + '" more than once. Codes must be unique; ' +
              'note that codes differing only in case are different codes.');
            break;
          }
          seen[code] = true;
        }
      });

      if (raw.deathCategory) { cfg.deathCategory = String(raw.deathCategory); }
      cfg.configVersion = typeof raw.configVersion === 'number' ? raw.configVersion : 1;
      cfg.schemaVersion = UR.CONFIG_SCHEMA_VERSION;
      cfg.rulesetVersion = UR.RULESET_VERSION;
      if (raw.label) { cfg.label = String(raw.label); }

      /* Refuse anything that looks like leaked patient data (spec 4.3). */
      var suspicious = ['encounters', 'rows', 'patients', 'accounts', 'data'];
      for (var s = 0; s < suspicious.length; s++) {
        if (raw[suspicious[s]] !== undefined) {
          warnings.push('The file contains an unexpected "' + suspicious[s] + '" section. It was ignored: this application never imports patient data through a configuration file.');
        }
      }

      return { ok: errors.length === 0, errors: errors, warnings: warnings, config: errors.length === 0 ? cfg : null };
    },

    /* Increment the user-facing configuration version (spec 14). */
    bumpVersion: function (config) {
      config.configVersion = (config.configVersion || 0) + 1;
      return config.configVersion;
    },

    /* Serialize for download. Strips anything outside the whitelist. */
    toJSON: function (config, isoTimestamp) {
      var out = pickAllowed(config);
      out.schemaVersion = UR.CONFIG_SCHEMA_VERSION;
      out.rulesetVersion = UR.RULESET_VERSION;
      out.appVersion = UR.APP_VERSION;
      out.savedAt = isoTimestamp || '';
      return JSON.stringify(out, null, 2);
    },

    /* Best-effort browser persistence of NON-PHI settings only (spec 14). */
    save: function (config, storage) {
      var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!store) { return { ok: false, reason: 'No browser storage available in this context.' }; }
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(pickAllowed(config)));
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'Browser storage refused the write (' + (e && e.name ? e.name : 'error') + '). Use Export configuration instead.' };
      }
    },

    load: function (storage) {
      var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!store) { return { ok: false, reason: 'No browser storage available in this context.', config: null }; }
      var text;
      try {
        text = store.getItem(STORAGE_KEY);
      } catch (e) {
        return { ok: false, reason: 'Browser storage could not be read.', config: null };
      }
      if (!text) { return { ok: false, reason: 'No saved configuration.', config: null }; }
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e2) {
        return { ok: false, reason: 'Saved configuration is not readable JSON.', config: null };
      }
      var res = configSchema.validate(parsed);
      return { ok: res.ok, reason: res.ok ? '' : res.errors.join(' '), config: res.config, warnings: res.warnings };
    },

    clear: function (storage) {
      var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!store) { return false; }
      try { store.removeItem(STORAGE_KEY); return true; } catch (e) { return false; }
    },

    /* --------------------------------------------------------- lookup helpers */

    /*
     * Every lookup goes through util.findByCode, which is case-sensitive with
     * reported fallbacks. The *Lookup variants return the full match result so
     * the caller can report how the code was resolved; the plain variants
     * return just the row for callers that only need the mapping.
     */
    serviceLookup: function (config, rawCode) {
      return util.findByCode(config.serviceCodes, rawCode);
    },

    serviceBehavior: function (config, rawCode) {
      var found = configSchema.serviceLookup(config, rawCode);
      if (!found.row) { return { behavior: UR.SERVICE.UNKNOWN, row: null, match: found.match, candidates: found.candidates }; }
      if (found.row.enabled === false) {
        return { behavior: UR.SERVICE.IGNORED, row: found.row, match: found.match, candidates: found.candidates };
      }
      return { behavior: found.row.behavior, row: found.row, match: found.match, candidates: found.candidates };
    },

    dischargeLookup: function (config, rawCode) {
      return util.findByCode(config.dischargeCodes, rawCode);
    },

    dischargeCode: function (config, rawCode) {
      return configSchema.dischargeLookup(config, rawCode).row;
    },

    insuranceLookup: function (config, rawCode) {
      return util.findByCode(config.insuranceCodes, rawCode);
    },

    insuranceCode: function (config, rawCode) {
      return configSchema.insuranceLookup(config, rawCode).row;
    },

    admissionSourceLookup: function (config, rawCode) {
      return util.findByCode(config.admissionSources, rawCode);
    },

    admissionSource: function (config, rawCode) {
      return configSchema.admissionSourceLookup(config, rawCode).row;
    }
  };

  UR.configSchema = configSchema;

})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * Functional acceptance criteria, spec 16.1 items 1-14.
 *
 * Each test below is named for the criterion it covers so the suite can be read
 * as evidence against the specification.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var harness = require('./harness');
var app = harness.load();
var UR = app.UR;
var XLSX = app.XLSX;
var fixtures = require('./fixtures/synthetic');
var fs = require('fs');
var path = require('path');

describe('acceptance criteria (spec 16.1)', function () {

  test('1. imports a CPSI export and auto-maps the known raw headers', function () {
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fixtures.matrix()), 'AdHoc');

    ['xlsx', 'csv'].forEach(function (bookType) {
      var bytes = new Uint8Array(XLSX.write(wb, { bookType: bookType, type: 'array' }));
      var read = UR.spreadsheetReader.readFile('cpsi-export.' + bookType, bytes);
      assert.equal(read.error, null, bookType + ' read without error');
      var sheet = UR.spreadsheetReader.pickDataSheet(read.sheets);
      assert.equal(sheet.rowCount, fixtures.ROWS.length, bookType + ' row count');
      var auto = UR.headerMapper.autoMap(sheet.headers);
      assert.equal(auto.mapping.service.header, 'visit_servicecd_key', bookType + ' service mapping');
      assert.equal(auto.mapping.ageYears.header, 'ipv1_age_years', bookType + ' age mapping');
      assert.equal(auto.mapping.admissionSource.header, 'ipv1_origin', bookType + ' origin mapping');
      assert.equal(auto.unmapped.length, 0, bookType + ': every canonical field mapped');
    });
  });

  test('2. allows manual correction of header mappings before processing', function () {
    var source = fixtures.buildSource(UR);
    /* Repoint the service column at the wrong column, as a user override would. */
    source.mapping.service = { header: 'visit_ins', index: source.headers.indexOf('visit_ins'), confidence: 0, basis: 'Chosen by user' };
    var s = UR.pipeline.process([source], fixtures.buildConfig(UR), {});
    assert.ok(s.blocked, 'the override is honoured, and the resulting data is refused');

    var restored = fixtures.buildSource(UR);
    var ok = UR.pipeline.process([restored], fixtures.buildConfig(UR), {});
    assert.notOk(ok.blocked);
  });

  test('3. includes only IP/OS/SB and reports every other code', function () {
    var s = fixtures.run(UR);
    s.encounters.forEach(function (e) {
      if (e.metricEligible) {
        assert.ok(UR.util.contains(UR.INCLUDED_SERVICES, e.serviceClass), e.account + ' is IP, OS, or SB');
      }
    });
    var inventory = s.codeInventory[0].rows;
    var zz = inventory.filter(function (r) { return r.value === 'ZZ'; })[0];
    var op = inventory.filter(function (r) { return r.value === 'OP'; })[0];
    assert.equal(zz.status, 'Unrecognized');
    assert.equal(op.status, 'Recognized / ignored');
  });

  test('4. builds episodes from patient identity, discharge code, expected service, and timing', function () {
    var s = fixtures.run(UR);
    var a101 = null, a104 = null;
    s.encounters.forEach(function (e) {
      if (e.account === 'A101') { a101 = e; }
      if (e.account === 'A104') { a104 = e; }
    });
    assert.ok(/^P\d+$/.test(a101.mrn), 'the patient carries a derived Patient ID: ' + a101.mrn);
    assert.equal(a101.mrn, a104.mrn, 'all four accounts share one derived patient (same name and age)');
    assert.equal(a101.episodeId, a104.episodeId, 'and one episode spans the OS -> IP -> SB -> IP course');
    var ep = s.episodes.filter(function (x) { return x.episodeId === a101.episodeId; })[0];
    assert.deepEqual(ep.serviceSequence, ['OS', 'IP', 'SB', 'IP']);
  });

  test('5. links a real-world 4-minute status-change gap', function () {
    var s = fixtures.run(UR);
    var link = s.transitions.filter(function (t) { return t.fromAccount === 'A101'; })[0];
    assert.close(link.gapMinutes, 4, 1e-9);
    assert.equal(link.confidence, UR.LINK_CONFIDENCE.CONFIRMED);
  });

  test('6. does not classify internal transitions as readmissions', function () {
    var s = fixtures.run(UR);
    var internalAccounts = ['A102', 'A103', 'A104', 'A202'];
    s.readmissions.pairs.forEach(function (p) {
      assert.ok(internalAccounts.indexOf(p.newIPAccount) < 0, p.newIPAccount + ' is an internal transition, not a readmission');
    });
  });

  test('7. attaches Rule IDs to exported results and reference rows', function () {
    var s = fixtures.run(UR);
    var wb = UR.workbookBuilder.build(s, '').workbook;
    /* The Executive Summary is written for a reader and deliberately carries
     * no Rule IDs; the Calculation Reference documents every one. */
    var reference = XLSX.utils.sheet_to_csv(wb.Sheets['Calculation Reference']);
    ['IP_ALOS_001', 'IP_TARGET_001', 'PD_EQ_001', 'PD_MN_001', 'READMIT_30_001'].forEach(function (id) {
      assert.includes(reference, id);
    });
    var queue = XLSX.utils.sheet_to_json(wb.Sheets['Review Queue'], { header: 1 });
    assert.equal(queue[0][0], 'Rule ID');
  });

  test('8. produces an objective review queue with no clinical conclusion', function () {
    var s = fixtures.run(UR);
    assert.ok(s.reviewQueue.rows.length > 0);
    var forbidden = ['not medically necessary', 'denied', 'inappropriate', 'non-compliant', 'avoidable'];
    s.reviewQueue.rows.forEach(function (r) {
      var text = (r.detail || '').toLowerCase();
      forbidden.forEach(function (word) {
        assert.ok(text.indexOf(word) < 0, r.ruleId + ' must not state "' + word + '"');
      });
    });
  });

  test('9. produces a complete data quality and code inventory report', function () {
    var s = fixtures.run(UR);
    assert.ok(s.diagnostics.count() > 0);
    assert.equal(s.codeInventory.length, 4, 'service, discharge, insurance, and admission source');
    s.codeInventory.forEach(function (section) {
      section.rows.forEach(function (row) {
        assert.ok(row.status, section.type + ' value ' + row.value + ' has a status');
        assert.ok(row.count > 0);
      });
    });
  });

  test('10. generates a multi-sheet workbook with no macros or external links', function () {
    var s = fixtures.run(UR);
    var bytes = UR.workbookBuilder.toBytes(s, '');
    var wb = XLSX.read(bytes, { type: 'array' });
    assert.equal(wb.SheetNames.length, 17);
    UR.zipPatch.parseZip(bytes).forEach(function (entry) {
      assert.ok(entry.name.indexOf('vbaProject') < 0);
      assert.ok(entry.name.indexOf('externalLink') < 0);
    });
  });

  test('11. works offline: no network call anywhere in the application', function () {
    var offenders = [];
    function walk(dir) {
      fs.readdirSync(dir).forEach(function (entry) {
        var full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) { walk(full); return; }
        if (!/\.(js|html|css)$/.test(entry)) { return; }
        var text = fs.readFileSync(full, 'utf8');
        if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon/.test(text)) {
          offenders.push(path.relative(harness.ROOT, full));
        }
      });
    }
    walk(path.join(harness.ROOT, 'src'));
    assert.deepEqual(offenders, []);
    var html = fs.readFileSync(path.join(harness.ROOT, 'index.html'), 'utf8');
    assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'index.html loads nothing remotely');
  });

  test('12. does not persist imported patient rows in browser storage', function () {
    var s = fixtures.run(UR);
    var store = {};
    var fakeStorage = {
      setItem: function (k, v) { store[k] = v; },
      getItem: function (k) { return store[k] || null; },
      removeItem: function (k) { delete store[k]; }
    };
    UR.configSchema.save(s.config, fakeStorage);
    var written = JSON.stringify(store);
    ['TEST, ALPHA', 'A101', '1001', 'B301'].forEach(function (token) {
      assert.ok(written.indexOf(token) < 0, 'storage must not contain ' + token);
    });
  });

  test('13. configuration exports and imports as JSON', function () {
    var config = fixtures.buildConfig(UR);
    config.transition.maxGapMinutes = 90;
    var round = UR.configSchema.validate(JSON.parse(UR.configSchema.toJSON(config, '')));
    assert.ok(round.ok);
    assert.equal(round.config.transition.maxGapMinutes, 90);
  });

  test('14. the Calculation Reference is available in-app and in the export', function () {
    var s = fixtures.run(UR);
    var records = UR.calculationReferenceSheet.records(s.config);
    var ids = records.map(function (r) { return r.id; });
    UR.calculationRules.ids().concat(UR.reviewRules.ids()).forEach(function (id) {
      assert.ok(ids.indexOf(id) >= 0, id + ' is on the in-app reference page');
    });
    var text = XLSX.utils.sheet_to_csv(UR.workbookBuilder.calculationReference(s));
    assert.includes(text, 'CALCULATION RULES');
    assert.includes(text, 'REVIEW QUEUE TRIGGERS');
    assert.includes(text, 'DATA QUALITY RULES');
    assert.includes(text, 'EXTERNAL REFERENCES');
  });
});

describe('determinism', function () {

  test('two runs over identical input produce identical output', function () {
    var a = fixtures.run(UR);
    var b = fixtures.run(UR);
    function fingerprint(s) {
      return JSON.stringify({
        episodes: s.episodes.map(function (e) { return e.episodeId + ':' + e.accounts.join('|'); }),
        review: s.reviewQueue.rows.map(function (r) { return r.ruleId + ':' + r.account; }),
        metrics: {
          ipAdm: s.metrics.inpatient.IP_ADM_001.value,
          alos: s.metrics.inpatient.IP_ALOS_001.hours,
          pdEq: s.metrics.census.PD_EQ_001.value,
          pdMn: s.metrics.census.PD_MN_001.value
        },
        diagnostics: s.diagnostics.sorted().map(function (d) { return d.ruleId + ':' + d.account; })
      });
    }
    assert.equal(fingerprint(a), fingerprint(b));
  });

  test('row order in the source does not change the result', function () {
    var forward = fixtures.run(UR);
    var reversed = fixtures.run(UR, { matrix: [fixtures.HEADERS.slice()].concat(fixtures.ROWS.slice().reverse()) });
    assert.equal(reversed.metrics.inpatient.IP_ADM_001.value, forward.metrics.inpatient.IP_ADM_001.value);
    assert.equal(reversed.metrics.observation.OSIP_001.value, forward.metrics.observation.OSIP_001.value);
    assert.equal(reversed.episodes.length, forward.episodes.length);
    assert.close(reversed.metrics.census.PD_EQ_001.value, forward.metrics.census.PD_EQ_001.value, 1e-9);

    function sequences(s) {
      return s.episodes.map(function (e) { return e.accounts.join('|'); }).sort().join(';');
    }
    assert.equal(sequences(reversed), sequences(forward), 'the same episodes are reconstructed');
  });
});

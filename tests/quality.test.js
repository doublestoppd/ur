/*
 * Data quality, code inventory, and the "no silent unknowns" guarantee
 * (spec 7.2, 11, fixtures T10-T12, T16, T17).
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var app = require('./harness').load();
var UR = app.UR;
var fixtures = require('./fixtures/synthetic');

var state = fixtures.run(UR);

function ruleIds(diagnostics) {
  var ids = {};
  diagnostics.all().forEach(function (d) { ids[d.ruleId] = (ids[d.ruleId] || 0) + 1; });
  return ids;
}

function encounter(s, account) {
  var found = null;
  s.encounters.forEach(function (e) { if (e.account === account) { found = e; } });
  return found;
}

describe('data quality - exclusions are visible', function () {

  test('T10 excludes an unrecognized service code and reports it', function () {
    var e = encounter(state, 'A701');
    assert.equal(e.serviceClass, UR.SERVICE.UNKNOWN);
    assert.equal(e.metricEligible, false);
    assert.includes(e.excludedReason, 'Unrecognized service code');
    assert.ok(ruleIds(state.diagnostics).DQ_SVC_UNKNOWN >= 1);
  });

  test('T11 counts an ignored service code separately from an unknown one', function () {
    var e = encounter(state, 'A801');
    assert.equal(e.serviceClass, UR.SERVICE.IGNORED);
    assert.equal(e.metricEligible, false);
    var ids = ruleIds(state.diagnostics);
    assert.ok(ids.DQ_SVC_IGNORED >= 1, 'ignored codes are informational');
    assert.equal(UR.dataQualityRules.byId('DQ_SVC_IGNORED').severity, UR.SEVERITY.INFO);
    assert.equal(UR.dataQualityRules.byId('DQ_SVC_UNKNOWN').severity, UR.SEVERITY.WARNING);
  });

  test('T12 keeps LOS for an unknown discharge code and assumes no transition', function () {
    var e = encounter(state, 'A901');
    assert.close(e.durationHours, 74, 1e-9, 'LOS is still calculated');
    assert.equal(e.dispositionCategory, 'Unknown');
    assert.equal(e.transitionTo, null, 'no transition is assumed');
    assert.ok(ruleIds(state.diagnostics).DQ_DISCD_UNKNOWN >= 1);
  });

  test('T16 treats a missing discharge as an open encounter', function () {
    var e = encounter(state, 'B301');
    assert.equal(e.isOpen, true);
    assert.equal(e.durationHours, null);
    assert.ok(state.metrics.inpatient.IP_ALOS_001.accounts.indexOf('B301') < 0, 'excluded from discharged ALOS');
    assert.ok(ruleIds(state.diagnostics).DQ_OPEN >= 1);
  });

  test('T17 collapses an identical duplicate account instead of double-counting', function () {
    var matches = state.encounters.filter(function (e) { return e.account === 'B401'; });
    assert.equal(matches.length, 1, 'counted once');
    assert.ok(state.duplicatesRemoved >= 1);
    assert.ok(ruleIds(state.diagnostics).DQ_ROW_DEDUP >= 1, 'the removal is reported, never silent');
  });

  test('diagnostic counts never exceed the number of retained rows', function () {
    /* The duplicate B401 row raises the same findings as the copy that was
     * kept; both would otherwise be reported. */
    var perRule = {};
    state.diagnostics.all().forEach(function (d) {
      if (!d.rowId) { return; }
      perRule[d.ruleId] = (perRule[d.ruleId] || 0) + 1;
    });
    Object.keys(perRule).forEach(function (ruleId) {
      assert.ok(perRule[ruleId] <= state.encounters.length,
        ruleId + ' raised ' + perRule[ruleId] + ' findings for ' + state.encounters.length + ' retained rows');
    });
    var rowIds = {};
    state.encounters.forEach(function (e) { rowIds[e.rowId] = true; });
    state.diagnostics.all().forEach(function (d) {
      if (d.rowId === null || d.rowId === undefined) { return; }
      assert.ok(rowIds[d.rowId], 'finding ' + d.ruleId + ' points at a row that was dropped');
    });
  });

  test('a conflicting duplicate account is excluded rather than merged', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9401', 'D1', 'CONFLICT, TEST', 'IP', '08/10/2026', 600, '08/11/2026', 600, 'BCBS', 'H', 1],
      ['9401', 'D1', 'CONFLICT, TEST', 'IP', '08/10/2026', 600, '08/14/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.accountConflicts, 1);
    s.encounters.forEach(function (e) { assert.equal(e.metricEligible, false, 'neither copy is counted'); });
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 0);
    assert.ok(ruleIds(s.diagnostics).DQ_ACCT_CONFLICT >= 2);
  });

  test('a discharge before admission beyond tolerance is an error and is excluded', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9402', 'N1', 'NEGATIVE, TEST', 'IP', '08/10/2026', 1200, '08/10/2026', 800, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters[0].metricEligible, false);
    var d = s.diagnostics.all().filter(function (x) { return x.ruleId === 'DQ_NEG_LOS'; });
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, UR.SEVERITY.ERROR);
  });

  test('a missing time is reported and midnight is assumed', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9403', 'T1', 'NOTIME, TEST', 'IP', '08/10/2026', '', '08/12/2026', '', 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters[0].admitTimeAssumed, true);
    assert.close(s.encounters[0].durationHours, 48, 1e-9);
    assert.ok(ruleIds(s.diagnostics).DQ_TIME_MISSING >= 2, 'both ends are reported');
  });

  test('a missing MRN blocks linkage but keeps the row usable for LOS', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['', 'R1', 'NOMRN, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters[0].metricEligible, true, 'still counted in LOS metrics');
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 1);
    assert.ok(ruleIds(s.diagnostics).DQ_MRN_MISSING >= 1);
    assert.equal(s.readmissions.pairs.length, 0, 'but it cannot participate in readmission logic');
  });

  test('a missing account number gets a traceable synthetic identifier', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9404', '', 'NOACCT, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters[0].accountSynthetic, true);
    assert.includes(s.encounters[0].account, 'ROW-');
    assert.ok(ruleIds(s.diagnostics).DQ_ACCT_MISSING >= 1);
  });
});

describe('data quality - blocking conditions', function () {

  test('no recognizable service code blocks the run', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9501', 'Q1', 'X', 'QQ', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.ok(s.blocked, 'processing stops');
    assert.equal(s.metrics, null);
    assert.ok(s.diagnostics.hasBlocking());
  });

  test('no parseable admission date blocks the run', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9502', 'Q2', 'X', 'IP', 'not a date', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.ok(s.blocked);
    var ids = ruleIds(s.diagnostics);
    assert.ok(ids.DQ_DATE_COLUMN >= 1);
  });

  test('an empty file blocks the run', function () {
    var s = fixtures.run(UR, { matrix: [fixtures.HEADERS.slice()] });
    assert.ok(s.blocked);
    assert.ok(ruleIds(s.diagnostics).DQ_NO_ROWS >= 1);
  });
});

describe('code inventory', function () {

  test('every distinct code appears with a count and a status', function () {
    var byType = {};
    state.codeInventory.forEach(function (sec) { byType[sec.type] = sec; });
    assert.ok(byType['Service code'] && byType['Discharge code'] && byType['Insurance code'] && byType['Admission source']);

    var serviceValues = byType['Service code'].rows.map(function (r) { return r.value; });
    ['IP', 'OS', 'SB', 'ZZ', 'OP'].forEach(function (code) {
      assert.ok(serviceValues.indexOf(code) >= 0, code + ' appears in the inventory');
    });

    var zz = byType['Service code'].rows.filter(function (r) { return r.value === 'ZZ'; })[0];
    assert.equal(zz.status, UR.codeInventory.STATUS.UNRECOGNIZED);
    var op = byType['Service code'].rows.filter(function (r) { return r.value === 'OP'; })[0];
    assert.equal(op.status, UR.codeInventory.STATUS.IGNORED);
    var ip = byType['Service code'].rows.filter(function (r) { return r.value === 'IP'; })[0];
    assert.equal(ip.status, UR.codeInventory.STATUS.USED);
    assert.includes(ip.behavior, 'Included as IP');
  });

  test('counts in the inventory reconcile with the imported rows', function () {
    var section = state.codeInventory[0];
    var total = 0;
    section.rows.forEach(function (r) { total += r.count; });
    assert.equal(total, state.encounters.length, 'every retained row is represented exactly once');
  });

  test('a discharge code outside the hospital table is surfaced', function () {
    var dis = state.codeInventory[1];
    var r = dis.rows.filter(function (row) { return row.value === 'Y'; })[0];
    assert.ok(r, 'code Y appears');
    assert.equal(r.status, UR.codeInventory.STATUS.UNRECOGNIZED);
  });

  test('unmapped values can be turned into starter mapping rows', function () {
    var suggestions = UR.codeInventory.suggestedMappings(state.codeInventory);
    var serviceCodes = suggestions.serviceCodes.map(function (r) { return r.code; });
    assert.ok(serviceCodes.indexOf('ZZ') >= 0);
    var dischargeCodes = suggestions.dischargeCodes.map(function (r) { return r.code; });
    assert.ok(dischargeCodes.indexOf('Y') >= 0);
  });
});

describe('diagnostics', function () {

  test('severity ordering and roll-up work', function () {
    var d = UR.diagnostics.create();
    d.add('DQ_OPEN', { account: 'A' });
    d.add('DQ_SVC_UNKNOWN', { account: 'B' });
    d.add('DQ_NEG_LOS', { account: 'C' });
    d.add('DQ_SVC_UNKNOWN', { account: 'D' });
    var sorted = d.sorted();
    assert.equal(sorted[0].severity, UR.SEVERITY.ERROR, 'errors first');
    assert.equal(sorted[sorted.length - 1].severity, UR.SEVERITY.INFO, 'info last');
    var counts = d.counts();
    assert.equal(counts.Error, 1);
    assert.equal(counts.Warning, 2);
    assert.equal(counts.Info, 1);
    var grouped = d.byRule();
    var unknown = grouped.filter(function (g) { return g.ruleId === 'DQ_SVC_UNKNOWN'; })[0];
    assert.equal(unknown.count, 2);
    assert.deepEqual(unknown.samples, ['B', 'D']);
  });

  test('every diagnostic id used by the engine exists in the registry', function () {
    state.diagnostics.all().forEach(function (d) {
      assert.ok(UR.dataQualityRules.byId(d.ruleId), 'unregistered diagnostic id: ' + d.ruleId);
    });
  });

  test('out-of-period rows are retained for context and reported', function () {
    var matrix = [
      fixtures.HEADERS.slice(),
      ['9601', 'J1', 'JULY, TEST', 'IP', '07/10/2026', 600, '07/12/2026', 600, 'BCBS', 'H', 1],
      ['9601', 'J2', 'AUG, TEST', 'IP', '08/10/2026', 600, '08/12/2026', 600, 'BCBS', 'H', 1]
    ];
    var s = fixtures.run(UR, { matrix: matrix });
    assert.equal(s.encounters.length, 2, 'the July row is retained');
    assert.equal(s.metrics.inpatient.IP_ADM_001.value, 1, 'but not counted in August');
    assert.ok(ruleIds(s.diagnostics).DQ_OUT_OF_PERIOD >= 1);
    assert.equal(s.readmissions.pairs.length, 1, 'and it still provides readmission context');
  });

  test('the processing summary reports the spec 11.3 counts', function () {
    var text = state.summaryLines.join('\n');
    assert.includes(text, 'rows imported');
    assert.includes(text, 'IP |');
    assert.includes(text, 'service-code policy');
    assert.includes(text, 'transitions');
    assert.includes(text, 'blocking');
  });
});

describe('reporting period inference', function () {

  /* A one-month export from a hospital with swing beds contains admissions from
   * earlier months, because long stays discharge inside the reported month. */
  function longStayMatrix() {
    var rows = [fixtures.HEADERS.slice()];
    /* Twenty ordinary August encounters. */
    for (var i = 0; i < 20; i++) {
      var day = 1 + (i % 20);
      var d = (day < 10 ? '0' : '') + day;
      rows.push(['20' + i, 'AUG' + i, 'AUGUST, TEST', 'IP', '08/' + d + '/2026', 800, '08/' + d + '/2026', 1600, 'BCBS', 'H', 1]);
    }
    /* Two swing-bed patients admitted in June, discharged in August. */
    rows.push(['3001', 'SB1', 'LONG, TEST', 'SB', '06/12/2026', 900, '08/04/2026', 1100, 'BCBS', 'H', 1]);
    rows.push(['3002', 'SB2', 'LONG, TEST', 'SB', '06/28/2026', 900, '08/09/2026', 1100, 'BCBS', 'H', 1]);
    return rows;
  }

  test('a one-month export is not stretched across a quarter by long stays', function () {
    var s = fixtures.run(UR, { matrix: longStayMatrix(), periodStart: null, periodEnd: null, asOf: null });
    assert.equal(s.period.label, '08/01/2026 - 08/31/2026', 'the period is the month the data is about');
    assert.equal(UR.util.fmtDate(s.dataSpan.startDT), '06/12/2026', 'while the true data span is still reported');
    assert.deepEqual(s.suggestedPeriod.droppedMonths, ['2026-06']);
  });

  test('the months treated as context are explained, not silently dropped', function () {
    var s = fixtures.run(UR, { matrix: longStayMatrix(), periodStart: null, periodEnd: null, asOf: null });
    var notice = s.diagnostics.all().filter(function (d) {
      return d.ruleId === 'DQ_OUT_OF_PERIOD' && d.message.indexOf('concentrates') >= 0;
    });
    assert.equal(notice.length, 1, 'the inference is reported');
    assert.includes(notice[0].message, 'Jun 2026');
    assert.includes(notice[0].message, 'Set the dates explicitly');
  });

  test('a genuine multi-month export keeps every month', function () {
    var rows = [fixtures.HEADERS.slice()];
    ['06', '07', '08'].forEach(function (mm, idx) {
      for (var i = 0; i < 10; i++) {
        var day = (i < 9 ? '0' : '') + (i + 1);
        rows.push(['4' + idx + i, 'M' + mm + i, 'MULTI, TEST', 'IP', mm + '/' + day + '/2026', 800, mm + '/' + day + '/2026', 1600, 'BCBS', 'H', 1]);
      }
    });
    var s = fixtures.run(UR, { matrix: rows, periodStart: null, periodEnd: null, asOf: null });
    assert.equal(s.period.label, '06/01/2026 - 08/31/2026');
    assert.deepEqual(s.suggestedPeriod.droppedMonths, []);
    assert.equal(s.monthly.length, 3, 'and each month gets its own trend row');
  });

  test('an explicit period always wins over the inference', function () {
    var s = fixtures.run(UR, {
      matrix: longStayMatrix(),
      periodStart: UR.util.mkDT(2026, 6, 1, 0, 0),
      periodEnd: UR.util.mkDT(2026, 8, 31, 0, 0)
    });
    assert.equal(s.period.label, '06/01/2026 - 08/31/2026');
    assert.equal(s.periodSource, 'Chosen by user');
  });

  test('a stray mistyped date cannot drag the period with it', function () {
    var rows = longStayMatrix();
    rows.push(['3003', 'TYPO', 'TYPO, TEST', 'IP', '08/15/2027', 800, '08/16/2027', 900, 'BCBS', 'H', 1]);
    var s = fixtures.run(UR, { matrix: rows, periodStart: null, periodEnd: null, asOf: null });
    assert.equal(s.period.label, '08/01/2026 - 08/31/2026');
    assert.ok(UR.util.contains(s.suggestedPeriod.droppedMonths, '2027-08'), 'the outlier month is reported as context');
  });
});

describe('monthly trend rows', function () {

  test('trend rows come from the reporting period, not from context months', function () {
    var rows = [fixtures.HEADERS.slice()];
    for (var i = 0; i < 12; i++) {
      var d = (i < 9 ? '0' : '') + (i + 1);
      rows.push(['50' + i, 'AUG' + i, 'AUGUST, TEST', 'IP', '08/' + d + '/2026', 800, '08/' + d + '/2026', 1600, 'BCBS', 'H', 1]);
    }
    /* One swing-bed stay admitted in June: context, never a trend column. */
    rows.push(['5100', 'SBJUN', 'LONG, TEST', 'SB', '06/12/2026', 900, '08/04/2026', 1100, 'BCBS', 'H', 1]);

    var s = fixtures.run(UR, { matrix: rows, periodStart: null, periodEnd: null, asOf: null });
    assert.equal(s.monthly.length, 1, 'one reporting month, not a Jun/Aug pair with July missing');
    assert.equal(s.monthly[0].label, 'Aug 2026');
  });

  test('a multi-month period produces contiguous months, including empty ones', function () {
    var rows = [fixtures.HEADERS.slice()];
    rows.push(['5200', 'JUN1', 'A, TEST', 'IP', '06/10/2026', 800, '06/12/2026', 800, 'BCBS', 'H', 1]);
    rows.push(['5201', 'AUG1', 'B, TEST', 'IP', '08/10/2026', 800, '08/12/2026', 800, 'BCBS', 'H', 1]);
    var s = fixtures.run(UR, {
      matrix: rows,
      periodStart: UR.util.mkDT(2026, 6, 1, 0, 0),
      periodEnd: UR.util.mkDT(2026, 8, 31, 0, 0)
    });
    var labels = s.monthly.map(function (m) { return m.label; });
    assert.deepEqual(labels, ['Jun 2026', 'Jul 2026', 'Aug 2026'],
      'July appears as a zero month rather than being skipped, so the trend reads correctly');
    assert.equal(s.monthly[1].metrics.inpatient.IP_ADM_001.value, 0);
  });

  test('a partial month is clamped to the period and flagged', function () {
    var rows = [fixtures.HEADERS.slice()];
    rows.push(['5300', 'M1', 'A, TEST', 'IP', '08/05/2026', 800, '08/06/2026', 800, 'BCBS', 'H', 1]);
    rows.push(['5301', 'M2', 'B, TEST', 'IP', '08/20/2026', 800, '08/21/2026', 800, 'BCBS', 'H', 1]);
    var s = fixtures.run(UR, {
      matrix: rows,
      periodStart: UR.util.mkDT(2026, 8, 10, 0, 0),
      periodEnd: UR.util.mkDT(2026, 8, 31, 0, 0)
    });
    assert.equal(s.monthly.length, 1);
    assert.equal(s.monthly[0].partial, true, 'the month is marked partial');
    assert.equal(s.monthly[0].period.days, 22, 'and covers only the selected days');
    assert.equal(s.monthly[0].metrics.inpatient.IP_ADM_001.value, 1, 'the 08/05 admission is outside the period');
  });
});

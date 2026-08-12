/*
 * workbookBuilder.js - builds the compiled Excel workbook (spec 13).
 *
 * One workbook per run, eighteen worksheets, no macros and no external links.
 * Datetimes are written as true Excel date cells using a wall-clock serial
 * number, so nothing is reinterpreted by the workstation's timezone.
 *
 * Patient names are omitted from every sheet when the run is configured to
 * exclude them (spec 4.3); the Executive Summary never carries names or MRNs
 * regardless (spec 13.1).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};
  var util = UR.util;

  var DATE_FMT = 'mm/dd/yyyy';
  var DATETIME_FMT = 'mm/dd/yyyy hh:mm';

  /* Cell markers resolved during sheet construction. */
  function D(dt) { return { __dt: true, v: util.isDate(dt) ? dt : null, fmt: DATETIME_FMT }; }
  function DAY(dt) { return { __dt: true, v: util.isDate(dt) ? dt : null, fmt: DATE_FMT }; }
  function N(v, places) {
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) { return null; }
    return util.round(v, places === undefined ? 2 : places);
  }
  function pctText(v) { return v === null || v === undefined ? '' : util.round(v, 1) + '%'; }
  function yn(v) { return v ? 'Yes' : 'No'; }

  /*
   * Row and cell markers for the styling pass (applied by zipPatch after the
   * workbook is written, since the bundled library cannot write fonts/fills).
   * The builder marks MEANING - "this row is a column header" - and the
   * patcher owns the appearance, so a restyle never touches sheet content.
   */
  function HDR(cells) { cells.__style = 'header'; return cells; }    /* column headers: white on accent, wrapped, starts a zebra region */
  function SEC(cells) { cells.__style = 'section'; return cells; }   /* section bar: accent on light accent, starts a zebra region */
  function TITLE(cells) { cells.__style = 'title'; return cells; }   /* sheet title: large accent text */
  function NOTE(cells) { cells.__style = 'note'; return cells; }     /* methodology note: small muted italic */
  function C(value, styleName) { return { __cell: true, v: value, style: styleName }; }
  function sevStyle(severity) { return 'sev' + severity; }           /* Blocking/Error/Warning/Info -> sevBlocking... */
  /* A percentage as a REAL numeric cell (stored as a fraction, shown as %),
   * so it right-aligns with the counts around it and works in formulas. */
  function PCT(v) { return v === null || v === undefined ? null : { __num: true, v: v / 100, fmt: '0.0%' }; }
  /* A text value ("Yes", "n/a") right-aligned to sit in a numeric column. */
  function R(v) { return C(v, 'valr'); }

  var ROW_HEIGHTS = { header: 26, section: 20, title: 30 };

  function xlsx() {
    var X = global.XLSX;
    if (!X) { throw new Error('The bundled spreadsheet library did not load.'); }
    return X;
  }

  /* Column widths from content, capped so a long note cannot swamp a sheet. */
  function autoWidths(aoa, maxWidth) {
    var cap = maxWidth || 46;
    var widths = [];
    for (var r = 0; r < aoa.length; r++) {
      var row = aoa[r] || [];
      for (var c = 0; c < row.length; c++) {
        var v = row[c];
        var len;
        if (v === null || v === undefined) { len = 0; }
        else if (v && v.__dt) { len = v.fmt === DATE_FMT ? 11 : 17; }
        else { len = String(v).length; }
        if (!widths[c] || widths[c] < len) { widths[c] = len; }
      }
    }
    var out = [];
    for (var i = 0; i < widths.length; i++) {
      out.push({ wch: Math.max(9, Math.min(cap, (widths[i] || 8) + 2)) });
    }
    return out;
  }

  /*
   * Convert an array of arrays into a worksheet, resolving date markers into
   * numeric cells with a date format, and collecting the sheet's style plan
   * from the row/cell markers: styled rows, targeted cells, and the zebra
   * bands computed from table shape (every second data row after a header or
   * section row, until a blank or styled row ends the table).
   */
  function makeSheet(aoa, opts) {
    var X = xlsx();
    var options = opts || {};
    var dateCells = [];
    var plain = [];
    var spec = { rows: {}, cells: {}, zebra: [] };
    var r, c, row;

    for (r = 0; r < aoa.length; r++) {
      row = aoa[r] || [];
      if (row.__style) { spec.rows[r + 1] = row.__style; }
      var outRow = [];
      for (c = 0; c < row.length; c++) {
        var v = row[c];
        if (v && v.__dt) {
          outRow.push(v.v === null ? null : util.toExcelSerial(v.v));
          if (v.v !== null) { dateCells.push({ r: r, c: c, fmt: v.fmt }); }
        } else if (v && v.__num) {
          outRow.push(v.v);
          dateCells.push({ r: r, c: c, fmt: v.fmt });
        } else if (v && v.__cell) {
          outRow.push(v.v === undefined ? null : v.v);
          spec.cells[X.utils.encode_cell({ r: r, c: c })] = v.style;
        } else {
          outRow.push(v === undefined ? null : v);
        }
      }
      plain.push(outRow);
    }

    /*
     * Zebra regions. Banding is a fill on cells, and a fill needs a cell to
     * sit on, so data rows inside a region are padded to the region's width
     * with empty strings - otherwise a blank column would punch holes in the
     * band.
     */
    function isBlank(cells) {
      for (var b = 0; b < cells.length; b++) {
        if (cells[b] !== null && cells[b] !== '') { return false; }
      }
      return true;
    }
    var regionStart = -1, regionRows = [];
    function closeRegion() {
      if (options.zebra === false || regionStart < 0 || regionRows.length < 2) { regionStart = -1; regionRows = []; return; }
      var width = plain[regionStart].length;
      var i;
      for (i = 0; i < regionRows.length; i++) {
        if (plain[regionRows[i]].length > width) { width = plain[regionRows[i]].length; }
      }
      while (plain[regionStart].length < width) { plain[regionStart].push(''); }
      for (i = 0; i < regionRows.length; i++) {
        var member = plain[regionRows[i]];
        for (var p = 0; p < width; p++) {
          if (p >= member.length) { member.push(''); }
          else if (member[p] === null) { member[p] = ''; }
        }
        if (i % 2 === 1) { spec.zebra.push(regionRows[i] + 1); }
      }
      regionStart = -1; regionRows = [];
    }
    for (r = 0; r < plain.length; r++) {
      var style = spec.rows[r + 1];
      if (style === 'header' || style === 'section') {
        closeRegion();
        regionStart = r;
      } else if (style || isBlank(plain[r])) {
        closeRegion();
      } else if (regionStart >= 0) {
        regionRows.push(r);
      }
    }
    closeRegion();

    /* A right-aligned text cell on a banded row needs the banded variant,
     * or the override would punch a white hole in the zebra stripe. */
    var zebraRows = {};
    for (var z = 0; z < spec.zebra.length; z++) { zebraRows[spec.zebra[z]] = true; }
    for (var addr in spec.cells) {
      if (Object.prototype.hasOwnProperty.call(spec.cells, addr) && spec.cells[addr] === 'valr') {
        if (zebraRows[Number(addr.replace(/^[A-Z]+/, ''))]) { spec.cells[addr] = 'valrZ'; }
      }
    }

    var ws = X.utils.aoa_to_sheet(plain);
    for (var i = 0; i < dateCells.length; i++) {
      var addr = X.utils.encode_cell({ r: dateCells[i].r, c: dateCells[i].c });
      if (ws[addr]) {
        ws[addr].t = 'n';
        ws[addr].z = dateCells[i].fmt;
      }
    }
    ws['!cols'] = options.cols || autoWidths(aoa, options.maxWidth);

    /* Styled rows get breathing room; the wrapped header needs two lines. */
    var heights = [];
    var anyHeight = false;
    for (var hr in spec.rows) {
      if (Object.prototype.hasOwnProperty.call(spec.rows, hr) && ROW_HEIGHTS[spec.rows[hr]]) {
        heights[Number(hr) - 1] = { hpt: ROW_HEIGHTS[spec.rows[hr]] };
        anyHeight = true;
      }
    }
    if (anyHeight) { ws['!rows'] = heights; }

    if (options.autofilter && plain.length > (options.headerRow || 1)) {
      var headerRowIndex = (options.headerRow || 1) - 1;
      var lastCol = 0;
      for (var h = 0; h < plain.length; h++) {
        if (plain[h] && plain[h].length > lastCol) { lastCol = plain[h].length; }
      }
      ws['!autofilter'] = {
        ref: X.utils.encode_range(
          { r: headerRowIndex, c: 0 },
          { r: Math.max(headerRowIndex, plain.length - 1), c: Math.max(0, lastCol - 1) }
        )
      };
    }
    ws.__urStyle = spec;
    return ws;
  }

  function nameCols(config) {
    return config.processing.excludePatientNames ? [] : ['Patient name'];
  }
  function nameVal(config, value) {
    return config.processing.excludePatientNames ? [] : [value || ''];
  }

  var workbookBuilder = {
    DATE_FMT: DATE_FMT,
    DATETIME_FMT: DATETIME_FMT,
    makeSheet: makeSheet,
    autoWidths: autoWidths,

    /* ------------------------------------------------ Executive Summary */
    executiveSummary: function (state) {
      var m = state.metrics;
      var cfg = state.config;
      var th = cfg.thresholds;
      var rows = [];

      /*
       * Month-by-month layout: one column per calendar month of the reporting
       * period, left to right, then a Total column for the whole period, then
       * notes. Each line is defined once by an extractor that runs against a
       * month's metrics and against the period metrics, so a month column and
       * the Total can never be computed differently.
       *
       * Rule IDs are deliberately absent here: this sheet is written for a
       * reader, and every figure's rule is documented in the Calculation
       * Reference worksheet.
       */
      var months = state.monthly;
      var readmitPeriod = UR.pipeline.readmissionsInPeriod(state, state.period);

      function sectionHeader(title) {
        var cells = [title];
        for (var i = 0; i < months.length; i++) {
          cells.push(C(months[i].label + (months[i].partial ? ' (partial)' : ''), 'secr'));
        }
        cells.push(C('Total', 'secr'));
        cells.push('Notes');
        return SEC(cells);
      }

      function line(label, fn, note) {
        var cells = [label];
        for (var i = 0; i < months.length; i++) {
          cells.push(fn(months[i].metrics, months[i].readmissions));
        }
        cells.push(fn(m, readmitPeriod));
        cells.push(note || '');
        return cells;
      }

      rows.push(TITLE(['CPSI Utilization Review Data Compiler - Executive Summary']));
      rows.push(['Reporting period', state.period.label]);
      rows.push(['Generated', state.generatedAtText || '']);
      rows.push(['Application / ruleset / configuration version', UR.APP_VERSION + ' / ' + UR.RULESET_VERSION + ' / ' + cfg.configVersion]);
      rows.push(NOTE(['Regulatory figures below are surveillance aids. They are not official compliance reporting and must be validated against hospital policy and current payer/CMS requirements. Rule IDs and formulas for every line are in the Calculation Reference worksheet.']));
      rows.push([]);

      rows.push(sectionHeader('CAH ACUTE INPATIENT'));
      rows.push(line('Acute IP admissions (service accounts)', function (mm) { return mm.inpatient.IP_ADM_001.value; }, 'Includes accounts created by internal status changes.'));
      rows.push(line('Discharged IP accounts in scope', function (mm) { return mm.inpatient.IP_ALOS_001.n; }, 'Basis: ' + cfg.processing.losBasis + ' date within each column\'s range.'));
      rows.push(line('Acute IP mean LOS (hours)', function (mm) { return N(mm.inpatient.IP_ALOS_001.hours); }));
      rows.push(line('Acute IP mean LOS (days)', function (mm) { return N(mm.inpatient.IP_ALOS_001.days); }));
      rows.push(line('Acute IP median LOS (hours)', function (mm) { return N(mm.inpatient.IP_MEDLOS_001.hours); }));
      rows.push(line(th.acuteTargetDays + '-day (' + (th.acuteTargetDays * 24) + '-hour) target variance (days)', function (mm) { return N(mm.inpatient.IP_TARGET_001.varianceDays); },
        'Surveillance estimate only. The CAH requirement is an ANNUAL average; these are period figures for early warning.'));
      rows.push(line('Within ' + th.acuteTargetDays + '-day target', function (mm) {
        return R(mm.inpatient.IP_TARGET_001.withinTarget === null ? 'n/a' : yn(mm.inpatient.IP_TARGET_001.withinTarget));
      }));
      rows.push(line('Acute IP stays > ' + th.acuteTargetHours + 'h', function (mm) { return mm.inpatient.IP_GT4_001.value; }));
      rows.push(line('Percent of acute IP stays > ' + th.acuteTargetHours + 'h', function (mm) { return PCT(mm.inpatient.IP_GT4_PCT_001.value); },
        'Of qualifying discharged IP accounts in each column.'));
      rows.push(line('Excess days above target (total)', function (mm) { return N(mm.inpatient.IP_EXCESS_001.totalDays); }));
      rows.push(line('One-day acute stays (<= ' + th.oneDayStayHours + 'h)', function (mm) { return mm.inpatient.IP_SHORT_001.value; }));
      rows.push(line('Percent of one-day acute stays', function (mm) { return PCT(mm.inpatient.IP_1DAY_PCT_001.value); },
        'Of qualifying discharged IP accounts in each column.'));
      rows.push(line('Medicare/MA IP crossing < ' + th.shortStayMidnights + ' midnights', function (mm) { return mm.inpatient.IP_2MN_001.value; },
        'Review candidates only; no appropriateness conclusion.'));
      rows.push(line('Percent of Medicare/MA IP crossing < ' + th.shortStayMidnights + ' midnights', function (mm) { return PCT(mm.inpatient.IP_2MN_PCT_001.value); },
        'Of Medicare/MA qualifying discharged IP accounts - not of all discharged accounts.'));
      rows.push([]);

      rows.push(sectionHeader('OBSERVATION'));
      rows.push(line('Observation admissions', function (mm) { return mm.observation.OS_ADM_001.value; }));
      rows.push(line('Observation mean duration (hours)', function (mm) { return N(mm.observation.OS_ALOS_001.meanHours); }));
      rows.push(line('Observation median duration (hours)', function (mm) { return N(mm.observation.OS_ALOS_001.medianHours); }));
      rows.push(line('Observation > ' + th.obsThresholdHours[0] + 'h', function (mm) { return mm.observation.OS_24_001.value; }));
      rows.push(line('Percent of observation > ' + th.obsThresholdHours[0] + 'h', function (mm) { return PCT(mm.observation.OS_24_PCT_001.value); },
        'Of qualifying discharged observation accounts in each column.'));
      rows.push(line('Observation > ' + th.obsThresholdHours[1] + 'h', function (mm) { return mm.observation.OS_36_001.value; }));
      rows.push(line('Observation > ' + th.obsThresholdHours[2] + 'h', function (mm) { return mm.observation.OS_48_001.value; }));
      rows.push(line('OS -> IP conversions', function (mm) { return mm.observation.OSIP_001.value; }));
      rows.push(line('OS -> IP conversion rate', function (mm) { return PCT(mm.observation.OSIP_RATE_001.value); },
        m.observation.OSIP_RATE_001.denominatorNote));
      rows.push(line('Mean observation hours before conversion', function (mm) { return N(mm.observation.OSIP_TIME_001.meanHours); }));
      rows.push([]);

      rows.push(sectionHeader('SWING BED'));
      rows.push(line('Swing-bed admissions', function (mm) { return mm.swingBed.SB_ADM_001.value; }));
      rows.push(line('Swing-bed mean LOS (days)', function (mm) { return N(mm.swingBed.SB_ALOS_001.meanDays); }, 'Excluded from the CAH acute average by design.'));
      rows.push(line('Swing-bed median LOS (days)', function (mm) { return N(mm.swingBed.SB_ALOS_001.medianDays); }));
      rows.push(line('IP -> SB transitions', function (mm) { return mm.swingBed.IPSB_001.value; }));
      rows.push(line('SB -> IP transitions', function (mm) { return mm.swingBed.SBIP_001.value; }, 'Hospital-specific use of discharge code V.'));
      rows.push([]);

      rows.push(sectionHeader('VOLUME, PATIENT DAYS AND CENSUS'));
      rows.push(line('Service admissions (IP+OS+SB)', function (mm) { return mm.census.ADM_SVC_001.value; }, m.census.ADM_SVC_001.note));
      rows.push(line('Unique continuous episodes', function (mm) { return mm.census.EPISODE_CNT_001.value; }, 'Recommended primary hospital-episode count.'));
      rows.push(line('Unique patients', function (mm) { return mm.census.PATIENT_CNT_001.value; }, 'A patient seen in two months counts in both columns; the Total is distinct patients.'));
      rows.push(line('Equivalent patient days (time-weighted)', function (mm) { return N(mm.census.PD_EQ_001.value); }, 'PAIRED METHOD - not yet validated as the hospital official patient-day measure.'));
      rows.push(line('  Inpatient (time-weighted)', function (mm) { return N(mm.census.PD_IP_001.equivalentDays); }));
      rows.push(line('  Observation (time-weighted)', function (mm) { return N(mm.census.PD_OS_001.equivalentDays); }));
      rows.push(line('  Swing bed (time-weighted)', function (mm) { return N(mm.census.PD_SB_001.equivalentDays); }));
      rows.push(line('Midnight census patient days', function (mm) { return mm.census.PD_MN_001.value; }, 'PAIRED METHOD - traditional midnight convention. The three service lines sum exactly to each total.'));
      rows.push(line('  Inpatient (midnight census)', function (mm) { return mm.census.PD_IP_001.midnightDays; }));
      rows.push(line('  Observation (midnight census)', function (mm) { return mm.census.PD_OS_001.midnightDays; }));
      rows.push(line('  Swing bed (midnight census)', function (mm) { return mm.census.PD_SB_001.midnightDays; }));
      rows.push(line('Time-weighted average daily census', function (mm) { return N(mm.census.ADC_EQ_001.value); }));
      rows.push(line('Midnight average daily census', function (mm) { return N(mm.census.ADC_MN_001.value); }));
      rows.push(line('Deaths', function (mm) { return mm.payer.DEATH_001.value; },
        pctText(m.payer.DEATH_001.percent) + ' of discharges over the full period.'));
      rows.push([]);

      var windows = th.readmissionWindowDays;
      rows.push(sectionHeader('READMISSIONS (INTERNAL OPERATIONAL INDICATORS)'));
      rows.push(line('Potential ' + windows[0] + '-day readmissions', function (mm, rr) { return rr.short; }, 'Not a CMS readmission rate.'));
      rows.push(line('Potential ' + windows[1] + '-day readmissions', function (mm, rr) { return rr.long; }, 'Not a CMS readmission rate.'));
      rows.push(line('Potential ' + windows[1] + '-day Medicare readmissions', function (mm, rr) { return rr.medicare; }, 'Payer taken from the readmitting IP account.'));
      rows.push([]);

      /* Review and data-quality counts exist for the run as a whole. */
      rows.push(SEC(['REVIEW QUEUE AND DATA QUALITY', 'Count', 'Notes']));
      var counts = state.reviewQueue.counts;
      var ids = UR.reviewRules.ids();
      for (var i = 0; i < ids.length; i++) {
        var rule = UR.reviewRules.byId(ids[i]);
        rows.push([rule.name, counts[ids[i]] || 0, '']);
      }
      rows.push(['Accounts on the review queue (distinct)', state.reviewQueue.byAccount.length, 'One account may appear for several reasons.']);
      var dq = state.diagnostics.counts();
      rows.push(['Diagnostics', dq.Blocking + ' blocking / ' + dq.Error + ' errors / ' + dq.Warning + ' warnings / ' + dq.Info + ' info', 'See the Data Quality worksheet.']);

      var important = [];
      var byRule = state.diagnostics.byRule(3);
      for (var b = 0; b < byRule.length; b++) {
        if (byRule[b].severity === UR.SEVERITY.BLOCKING || byRule[b].severity === UR.SEVERITY.ERROR) {
          important.push(byRule[b].name + ' (' + byRule[b].count + ')');
        }
      }
      if (important.length) {
        rows.push([]);
        rows.push(SEC(['IMPORTANT DATA-QUALITY WARNINGS', important.join('; ')]));
      }

      rows.push([]);
      rows.push(NOTE(['This worksheet intentionally contains no patient names, patient IDs, or account numbers.']));

      /*
       * Uniform geometry: the label column, one equal column per month, an
       * equal Total column, then notes. Sized here rather than from content,
       * so a long value in a meta row cannot stretch a month column.
       */
      var cols = [{ wch: 44 }];
      for (var w = 0; w < months.length; w++) { cols.push({ wch: 11 }); }
      cols.push({ wch: 11 });
      cols.push({ wch: 70 });
      return makeSheet(rows, { cols: cols });
    },

    /* --------------------------------------------------- Monthly Trends */
    monthlyTrends: function (state) {
      var rows = [];
      var th = state.config.thresholds;
      var header = [
        'Month', 'IP admissions', 'IP mean LOS (h)', 'IP median LOS (h)', 'IP > ' + th.acuteTargetHours + 'h',
        '% IP > ' + th.acuteTargetHours + 'h', 'IP one-day stays', '% IP one-day',
        'OS admissions', 'OS mean (h)', 'OS > ' + th.obsThresholdHours[0] + 'h', '% OS > ' + th.obsThresholdHours[0] + 'h',
        'OS -> IP conversions', 'SB admissions', 'SB mean LOS (d)',
        'Service admissions', 'Episodes', 'Equivalent patient days', 'Midnight patient days',
        'IP patient days', 'OS patient days', 'SB patient days',
        'Time-weighted ADC', 'Midnight ADC', 'Deaths',
        'Readmissions <= ' + th.readmissionWindowDays[0] + 'd', 'Readmissions <= ' + th.readmissionWindowDays[1] + 'd'
      ];
      var payerCats = UR.PAYER_CATEGORY_LIST;
      for (var p = 0; p < payerCats.length; p++) { header.push('Payer: ' + payerCats[p]); }
      rows.push(HDR(header));

      if (!state.monthly.length) {
        rows.push(['No month could be derived from the imported data.']);
        return makeSheet(rows, { autofilter: true });
      }

      for (var i = 0; i < state.monthly.length; i++) {
        var mo = state.monthly[i];
        var m = mo.metrics;
        var row = [
          mo.label,
          m.inpatient.IP_ADM_001.value,
          N(m.inpatient.IP_ALOS_001.hours),
          N(m.inpatient.IP_MEDLOS_001.hours),
          m.inpatient.IP_GT4_001.value,
          PCT(m.inpatient.IP_GT4_PCT_001.value),
          m.inpatient.IP_SHORT_001.value,
          PCT(m.inpatient.IP_1DAY_PCT_001.value),
          m.observation.OS_ADM_001.value,
          N(m.observation.OS_ALOS_001.meanHours),
          m.observation.OS_24_001.value,
          PCT(m.observation.OS_24_PCT_001.value),
          m.observation.OSIP_001.value,
          m.swingBed.SB_ADM_001.value,
          N(m.swingBed.SB_ALOS_001.meanDays),
          m.census.ADM_SVC_001.value,
          m.census.EPISODE_CNT_001.value,
          N(m.census.PD_EQ_001.value),
          m.census.PD_MN_001.value,
          m.census.PD_IP_001.midnightDays,
          m.census.PD_OS_001.midnightDays,
          m.census.PD_SB_001.midnightDays,
          N(m.census.ADC_EQ_001.value),
          N(m.census.ADC_MN_001.value),
          m.payer.DEATH_001.value,
          mo.readmissions.short,
          mo.readmissions.long
        ];
        var byCat = {};
        for (var c = 0; c < m.payer.PAYER_MIX_001.byCategory.length; c++) {
          byCat[m.payer.PAYER_MIX_001.byCategory[c].key] = m.payer.PAYER_MIX_001.byCategory[c].accounts;
        }
        for (var q = 0; q < payerCats.length; q++) { row.push(byCat[payerCats[q]] || 0); }
        rows.push(row);
      }

      rows.push([]);
      rows.push(NOTE(['Monthly figures use each calendar month as its own reporting period. Readmission counts are attributed to the month the readmitting episode began.']));
      rows.push(NOTE(['Both patient-day methods are shown; neither is designated the official hospital measure until validated (PD_EQ_001, PD_MN_001).']));
      return makeSheet(rows, { autofilter: true });
    },

    /* ------------------------------------------------------ Review Queue */
    reviewQueue: function (state) {
      var cfg = state.config;
      var rows = [];
      rows.push(HDR(
        ['Rule ID', 'Review reason', 'Account', 'Patient ID'].concat(nameCols(cfg)).concat(
          ['Service', 'Payer category', 'Episode ID', 'Admit', 'Discharge', 'Open',
           'Measure', 'Measure type', 'Related account(s)', 'Detail'])
      ));
      var qrows = state.reviewQueue.rows;
      for (var i = 0; i < qrows.length; i++) {
        var r = qrows[i];
        rows.push(
          [r.ruleId, r.ruleName, r.account, r.mrn].concat(nameVal(cfg, r.patientName)).concat(
            [r.service, r.payerCategory, r.episodeId, D(r.admit), D(r.discharge), yn(r.isOpen),
             N(r.measure), r.measureLabel, r.relatedAccount, r.detail])
        );
      }
      if (qrows.length === 0) { rows.push(['No account met a review trigger for this period.']); }
      return makeSheet(rows, { autofilter: true, maxWidth: 70 });
    },

    /* Grouped one-row-per-account companion view. */
    reviewQueueByAccount: function (state) {
      var cfg = state.config;
      var rows = [];
      rows.push(HDR(['Account', 'Patient ID'].concat(nameCols(cfg)).concat(
        ['Service', 'Payer category', 'Episode ID', 'Admit', 'Discharge', 'Reasons', 'Rule IDs', 'Detail'])));
      var list = state.reviewQueue.byAccount;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        rows.push([a.account, a.mrn].concat(nameVal(cfg, a.patientName)).concat(
          [a.service, a.payerCategory, a.episodeId, D(a.admit), D(a.discharge), a.reasonCount, a.ruleIds, a.reasons]));
      }
      return makeSheet(rows, { autofilter: true, maxWidth: 80 });
    },

    /* ---------------------------------------------------- detail sheets */
    detailSheet: function (state, serviceClass) {
      var cfg = state.config;
      var th = cfg.thresholds;
      var rows = [];
      var header = ['Account', 'Patient ID'].concat(nameCols(cfg)).concat(
        ['Age', 'Service code', 'Service', 'Admit', 'Discharge', 'Open', 'LOS hours', 'LOS days', 'Midnights',
         'Payer category', 'Insurance code', 'Discharge code', 'Disposition', 'Episode ID', 'Service sequence',
         'Linked from', 'Linked to', 'Link confidence', 'Review flags', 'Data flags', 'Source file', 'Source row']);

      if (serviceClass === UR.SERVICE.IP) {
        header.splice(header.indexOf('Payer category'), 0, '> ' + th.acuteTargetHours + 'h', 'Excess days', '<= ' + th.oneDayStayHours + 'h');
      } else if (serviceClass === UR.SERVICE.OS) {
        header.splice(header.indexOf('Payer category'), 0, '> ' + th.obsThresholdHours[0] + 'h', '> ' + th.obsThresholdHours[1] + 'h', '> ' + th.obsThresholdHours[2] + 'h', 'Converted to IP');
      }
      rows.push(HDR(header));

      var reviewByAccount = {};
      for (var q = 0; q < state.reviewQueue.rows.length; q++) {
        var rq = state.reviewQueue.rows[q];
        if (!reviewByAccount[rq.account]) { reviewByAccount[rq.account] = []; }
        if (reviewByAccount[rq.account].indexOf(rq.ruleId) < 0) { reviewByAccount[rq.account].push(rq.ruleId); }
      }

      for (var i = 0; i < state.encounters.length; i++) {
        var e = state.encounters[i];
        if (e.serviceClass !== serviceClass) { continue; }
        var flagIds = [];
        for (var f = 0; f < e.flags.length; f++) {
          if (flagIds.indexOf(e.flags[f].ruleId) < 0) { flagIds.push(e.flags[f].ruleId); }
        }
        var row = [e.account, e.mrn].concat(nameVal(cfg, e.name)).concat(
          [e.ageYears, e.serviceRaw, e.serviceClass, D(e.admitDT), D(e.dischargeDT), yn(e.isOpen),
           N(e.durationHours), N(e.durationDays), e.midnights]);

        if (serviceClass === UR.SERVICE.IP) {
          var over = e.durationHours !== null && e.durationHours > th.acuteTargetHours;
          row.push(yn(over));
          row.push(e.durationHours === null ? null : N(Math.max(e.durationHours - th.acuteTargetHours, 0) / 24));
          row.push(yn(e.durationHours !== null && e.durationHours > 0 && e.durationHours <= th.oneDayStayHours));
        } else if (serviceClass === UR.SERVICE.OS) {
          row.push(yn(e.durationHours !== null && e.durationHours > th.obsThresholdHours[0]));
          row.push(yn(e.durationHours !== null && e.durationHours > th.obsThresholdHours[1]));
          row.push(yn(e.durationHours !== null && e.durationHours > th.obsThresholdHours[2]));
          row.push(e.linkNext && e.linkNext.service === UR.SERVICE.IP ? e.linkNext.account : '');
        }

        row = row.concat([
          e.payerCategory, e.insuranceRaw, e.dischargeCodeRaw, e.dispositionCategory || '',
          e.episodeId || '', e.episodeServiceSequence || '',
          e.linkPrev ? e.linkPrev.account : '', e.linkNext ? e.linkNext.account : '',
          e.linkNext ? e.linkNext.confidence : (e.linkPrev ? e.linkPrev.confidence : ''),
          (reviewByAccount[e.account] || []).join(', '),
          flagIds.join(', '),
          e.sourceFile, e.sourceRowNumber
        ]);
        rows.push(row);
      }
      return makeSheet(rows, { autofilter: true, maxWidth: 40 });
    },

    /* ---------------------------------------------------------- Episodes */
    episodes: function (state) {
      var cfg = state.config;
      var rows = [];
      rows.push(HDR(['Episode ID', 'Patient ID'].concat(nameCols(cfg)).concat(
        ['Accounts', 'Account count', 'Service sequence', 'First admit', 'Final discharge', 'Open',
         'Total elapsed hours', 'Total elapsed days', 'Acute IP hours', 'Contains IP', 'Contains OS', 'Contains SB',
         'Final discharge code', 'Final disposition', 'Death', 'Final payer category', 'Includes probable link'])));
      for (var i = 0; i < state.episodes.length; i++) {
        var ep = state.episodes[i];
        rows.push([ep.episodeId, ep.mrn].concat(nameVal(cfg, ep.patientName)).concat(
          [ep.accounts.join(', '), ep.accountCount, ep.serviceSequence.join(' -> '),
           D(ep.startDT), D(ep.endDT), yn(ep.isOpen),
           N(ep.elapsedHours), N(ep.elapsedDays), N(ep.acuteIPHours),
           yn(ep.containsIP), yn(ep.containsOS), yn(ep.containsSB),
           ep.finalDischargeCode, ep.finalDisposition || '', yn(ep.isDeath),
           ep.finalPayerCategory, yn(ep.hasProbableLink)]));
      }
      return makeSheet(rows, { autofilter: true });
    },

    /* ------------------------------------------------------- Transitions */
    transitions: function (state) {
      var rows = [];
      rows.push(HDR(['Prior account', 'Next account', 'Patient ID', 'From service', 'To service', 'Expected service',
        'Discharge code', 'Prior discharge', 'Next admit', 'Gap minutes', 'Same calendar date',
        'Link confidence', 'Episode ID', 'Issue', 'Candidate accounts']));
      var byRowId = {};
      for (var i = 0; i < state.encounters.length; i++) { byRowId[state.encounters[i].rowId] = state.encounters[i]; }
      for (var t = 0; t < state.transitions.length; t++) {
        var tr = state.transitions[t];
        var from = byRowId[tr.fromRowId];
        rows.push([tr.fromAccount, tr.toAccount, tr.mrn, tr.fromService, tr.toService, tr.expectedService,
          tr.dischargeCode, D(tr.fromDischarge), D(tr.toAdmit),
          tr.gapMinutes === null ? null : N(tr.gapMinutes, 1),
          tr.sameDay === null ? '' : yn(tr.sameDay),
          tr.confidence, from ? (from.episodeId || '') : '', tr.issue, (tr.candidateAccounts || []).join(', ')]);
      }
      if (state.transitions.length === 0) { rows.push(['No internal status transition was attempted for this data.']); }
      rows.push([]);
      rows.push(NOTE(['Confirmed = single expected successor inside the configured gap. Probable = successor admits slightly before the prior discharge, within the overlap tolerance.']));
      rows.push(NOTE(['Ambiguous = more than one plausible successor; deliberately not linked. Missing successor = the discharge code expects a successor and none exists within the tolerances.']));
      rows.push(NOTE(['Refused (timing) = the expected successor exists but its recorded admission precedes the discharge beyond the overlap tolerance; both accounts are named so the registration times can be corrected.']));
      rows.push(NOTE(['Unlinked = a same-day service change with no transition discharge code; reported, never linked on timing alone.']));
      return makeSheet(rows, { autofilter: true, maxWidth: 60 });
    },

    /* ------------------------------------------------------ Readmissions */
    readmissions: function (state) {
      var cfg = state.config;
      var windows = cfg.thresholds.readmissionWindowDays;
      var rows = [];
      rows.push(HDR(['Patient ID'].concat(nameCols(cfg)).concat(
        ['New IP account', 'New episode ID', 'New episode start', 'Prior episode ID', 'Prior accounts',
         'Prior final discharge', 'Prior disposition', 'Prior discharge code', 'Days between',
         'Within ' + windows[0] + ' days', 'Within ' + windows[1] + ' days', 'Payer category', 'Medicare'])));
      var pairs = state.readmissions.pairs;
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        rows.push([p.mrn].concat(nameVal(cfg, p.patientName)).concat(
          [p.newIPAccount, p.newEpisodeId, D(p.newEpisodeStart), p.priorEpisodeId, p.priorAccounts,
           D(p.priorFinalDischarge), p.priorDisposition, p.priorDischargeCode, N(p.daysBetween),
           yn(p.within[String(windows[0])]), yn(p.within[String(windows[1])]), p.payerCategory, yn(p.isMedicare)]));
      }
      if (!pairs.length) { rows.push(['No episode pair fell inside the configured readmission windows.']); }
      rows.push([]);
      rows.push(NOTE(['INTERNAL OPERATIONAL INDICATOR. These are not CMS risk-standardized readmission measures: no risk adjustment, no planned-readmission algorithm, no condition cohorts, and no visibility of admissions at other facilities.']));
      rows.push(NOTE(['Internal OS/IP/SB status transitions are part of one episode and can never appear here.']));
      var lb = state.readmissions.lookback;
      if (lb && lb.affectedEpisodes) {
        rows.push(['Incomplete lookback: ' + lb.affectedEpisodes + ' acute IP episode(s) begin before ' + util.fmtDate(lb.cutoff) +
          ', within ' + lb.windowDays + ' days of the earliest imported admission. Counts understate the true number for that window.']);
      }
      return makeSheet(rows, { autofilter: true, maxWidth: 60 });
    },

    /* ----------------------------------------------------- Payer Summary */
    payerSummary: function (state) {
      var mix = state.metrics.payer.PAYER_MIX_001;
      var th = state.config.thresholds;
      var rows = [];
      rows.push(SEC(['BY MAPPED PAYER CATEGORY']));
      rows.push(HDR(['Payer category', 'Service accounts', '% of accounts', 'IP', 'OS', 'SB', 'Episodes',
        'Occupancy hours', 'IP occupancy hours', 'Equivalent patient days',
        'One-day IP stays', 'IP > ' + th.acuteTargetHours + 'h', 'OS > ' + th.obsThresholdHours[0] + 'h', 'Deaths']));
      var i, r;
      for (i = 0; i < mix.byCategory.length; i++) {
        r = mix.byCategory[i];
        rows.push([r.key, r.accounts, pctText(r.percentOfAccounts), r.ip, r.os, r.sb, r.episodeCount,
          N(r.occupancyHours), N(r.ipOccupancyHours), N(r.equivalentPatientDays),
          r.oneDayStays, r.longStays, r.obsOver24, r.deaths]);
      }
      rows.push([]);
      rows.push(SEC(['BY RAW INSURANCE CODE']));
      rows.push(HDR(['Insurance code', 'Service accounts', 'IP', 'OS', 'SB', 'Episodes',
        'Occupancy hours', 'Equivalent patient days', 'One-day IP stays', 'IP > ' + th.acuteTargetHours + 'h', 'OS > ' + th.obsThresholdHours[0] + 'h', 'Deaths']));
      for (i = 0; i < mix.byRawCode.length; i++) {
        r = mix.byRawCode[i];
        rows.push([r.key, r.accounts, r.ip, r.os, r.sb, r.episodeCount,
          N(r.occupancyHours), N(r.equivalentPatientDays), r.oneDayStays, r.longStays, r.obsOver24, r.deaths]);
      }
      rows.push([]);
      rows.push(NOTE(['Both views are exported so a payer-mapping error is visible instead of being hidden by aggregation. Unmapped insurance codes report under the Unknown category (PAYER_MIX_001).']));
      return makeSheet(rows, { maxWidth: 40 });
    },

    /* ----------------------------------------------- Disposition & Source */
    dispositionAndSource: function (state) {
      var payer = state.metrics.payer;
      var rows = [];
      var i;
      rows.push(SEC(['DISCHARGE DISPOSITION DISTRIBUTION (DISPO_001)']));
      rows.push(HDR(['Disposition category', 'Count', '% of discharges', 'Sample accounts']));
      for (i = 0; i < payer.DISPO_001.rows.length; i++) {
        var d = payer.DISPO_001.rows[i];
        rows.push([d.category, d.count, pctText(d.percent), d.accounts.slice(0, 8).join(', ')]);
      }
      rows.push(['Total discharges in period', payer.DISPO_001.denominator]);
      rows.push([]);

      rows.push(SEC(['DEATHS (DEATH_001)']));
      rows.push(HDR(['Scope', 'Count', '% of discharges']));
      rows.push(['All included services', payer.DEATH_001.value, pctText(payer.DEATH_001.percent)]);
      for (var s in payer.DEATH_001.byService) {
        if (Object.prototype.hasOwnProperty.call(payer.DEATH_001.byService, s)) {
          rows.push(['Service ' + s, payer.DEATH_001.byService[s], '']);
        }
      }
      for (var p in payer.DEATH_001.byPayer) {
        if (Object.prototype.hasOwnProperty.call(payer.DEATH_001.byPayer, p)) {
          rows.push(['Payer ' + p, payer.DEATH_001.byPayer[p], '']);
        }
      }
      rows.push([]);

      rows.push(SEC(['ADMISSION SOURCE (ADMSRC_001)']));
      if (!payer.ADMSRC_001.available) {
        rows.push(['No admission-source column was mapped for this run, so this summary is unavailable.']);
      } else {
        rows.push(HDR(['Source code', 'Mapped label', 'Category', 'Count', '% of admissions']));
        for (i = 0; i < payer.ADMSRC_001.rows.length; i++) {
          var sr = payer.ADMSRC_001.rows[i];
          rows.push([sr.code, sr.label, sr.category, sr.count, pctText(sr.percent)]);
        }
      }
      rows.push([]);

      rows.push(SEC(['ADMISSIONS AND DISCHARGES BY DAY OF WEEK (DOW_001)']));
      rows.push(HDR(['Day', 'Admissions', 'Discharges']));
      for (i = 0; i < 7; i++) {
        rows.push([payer.DOW_001.dayNames[i], payer.DOW_001.admits[i], payer.DOW_001.discharges[i]]);
      }
      rows.push([]);

      rows.push(SEC(['ACUTE IP LOS DISTRIBUTION (LOSDIST_001)']));
      rows.push(HDR(['Band', 'Count', '% of discharged IP']));
      var dist = state.metrics.inpatient.LOSDIST_001;
      for (i = 0; i < dist.bands.length; i++) {
        rows.push([dist.bands[i].label, dist.bands[i].count, pctText(dist.bands[i].percent)]);
      }
      rows.push([]);
      rows.push(HDR(['Percentile', 'Hours', 'Days']));
      for (i = 0; i < dist.percentiles.length; i++) {
        rows.push([dist.percentiles[i].label, N(dist.percentiles[i].hours), N(dist.percentiles[i].days)]);
      }
      return makeSheet(rows, { maxWidth: 40 });
    },

    /* ----------------------------------------------------- Notice Review */
    noticeReview: function (state) {
      var cfg = state.config;
      var rows = [];
      rows.push(TITLE(['MEDICARE NOTICE MANUAL-CHECK CANDIDATES']));
      rows.push(NOTE(['This worksheet lists accounts that objectively QUALIFY for a notice review. It is not proof of delivery.']));
      rows.push(NOTE(['CPSI cannot export scanned or signed notice status, so completion, timing, and signature must be verified manually for every row (R3, R4).']));
      rows.push([]);
      rows.push(HDR(['Rule ID', 'Notice', 'Account', 'Patient ID'].concat(nameCols(cfg)).concat(
        ['Service', 'Payer category', 'Admit', 'Discharge', 'Open', 'Hours', 'Detail'])));
      var qrows = state.reviewQueue.rows;
      var found = 0;
      for (var i = 0; i < qrows.length; i++) {
        var r = qrows[i];
        if (r.ruleId !== 'RQ_IMM' && r.ruleId !== 'RQ_MOON') { continue; }
        found++;
        rows.push([r.ruleId, r.ruleId === 'RQ_IMM' ? 'Important Message from Medicare' : 'Medicare Outpatient Observation Notice',
          r.account, r.mrn].concat(nameVal(cfg, r.patientName)).concat(
          [r.service, r.payerCategory, D(r.admit), D(r.discharge), yn(r.isOpen), N(r.measure), r.detail]));
      }
      if (!found) { rows.push(['No account met the objective notice-eligibility criteria for this period.']); }
      return makeSheet(rows, { autofilter: true, headerRow: 5, maxWidth: 70 });
    },

    /* -------------------------------------------------------- Data Quality */
    dataQuality: function (state) {
      var rows = [];
      rows.push(SEC(['SUMMARY BY RULE']));
      rows.push(HDR(['Severity', 'Rule ID', 'Rule', 'Occurrences', 'Sample accounts', 'Effect']));
      var byRule = state.diagnostics.byRule(8);
      var i;
      for (i = 0; i < byRule.length; i++) {
        var g = byRule[i];
        var rule = UR.dataQualityRules.byId(g.ruleId);
        rows.push([C(g.severity, sevStyle(g.severity)), g.ruleId, g.name, g.count, g.samples.join(', '), rule ? rule.effect : '']);
      }
      if (!byRule.length) { rows.push(['No diagnostic was raised for this run.']); }

      rows.push([]);
      rows.push(SEC(['ALL FINDINGS']));
      rows.push(HDR(['Severity', 'Rule ID', 'Rule', 'Account', 'Patient ID', 'Service', 'Value', 'Message', 'Source file', 'Source sheet', 'Source row']));
      var all = state.diagnostics.sorted();
      for (i = 0; i < all.length; i++) {
        var d = all[i];
        rows.push([C(d.severity, sevStyle(d.severity)), d.ruleId, d.name, d.account, d.mrn, d.service, d.value, d.message,
          d.sourceFile, d.sourceSheet, d.sourceRow]);
      }
      return makeSheet(rows, { autofilter: true, headerRow: 2, maxWidth: 90 });
    },

    /* ------------------------------------------------------ Code Inventory */
    codeInventory: function (state) {
      var rows = [];
      rows.push(NOTE(['Every distinct code encountered in the input appears below with its count, configured meaning, and status. No code is silently dropped.']));
      rows.push([]);
      rows.push(HDR(['Code type', 'Column mapped', 'Value', 'Count', 'Configured meaning', 'Behavior applied', 'Status', 'Sample accounts']));
      for (var s = 0; s < state.codeInventory.length; s++) {
        var sec = state.codeInventory[s];
        for (var r = 0; r < sec.rows.length; r++) {
          var row = sec.rows[r];
          rows.push([sec.type, yn(sec.mapped), row.value, row.count, row.mappedTo || '', row.behavior,
            row.status === UR.codeInventory.STATUS.UNRECOGNIZED ? C(row.status, 'sevWarning') : row.status,
            row.samples.join(', ')]);
        }
        if (!sec.rows.length) {
          rows.push([sec.type, yn(sec.mapped), '(no values encountered)', 0, '', '', '', '']);
        }
      }
      return makeSheet(rows, { autofilter: true, headerRow: 3, maxWidth: 46 });
    },

    /* ----------------------------------------------- Calculation Reference */
    calculationReference: function (state) {
      /*
       * The rows come from the reference-sheet generator; recognize its shape
       * rather than duplicating it: a single ALL-CAPS cell is a section bar,
       * and the row after a section bar is that table's column header.
       */
      var rows = UR.calculationReferenceSheet.allRows(state.config);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.length === 1 && typeof row[0] === 'string' && /^[A-Z][A-Z /&-]+$/.test(row[0])) {
          SEC(row);
          if (rows[i + 1] && rows[i + 1].length > 1) { HDR(rows[i + 1]); }
        }
      }
      return makeSheet(rows, { maxWidth: 90 });
    },

    /* ---------------------------------------------------------- Run Metadata */
    runMetadata: function (state) {
      var cfg = state.config;
      var rows = [];
      rows.push(TITLE(['RUN METADATA']));
      rows.push(['Generated', state.generatedAtText || '']);
      rows.push(['Application version', UR.APP_VERSION]);
      rows.push(['Calculation ruleset version', UR.RULESET_VERSION]);
      rows.push(['Configuration version', cfg.configVersion]);
      rows.push(['Configuration schema version', cfg.schemaVersion]);
      rows.push(['Reporting period', state.period.label]);
      rows.push(['Occupancy as-of datetime', D(state.period.asOf)]);
      rows.push(['Discharged-stay period basis', cfg.processing.losBasis]);
      rows.push(['Open encounters included in occupancy', yn(cfg.processing.includeOpenInOccupancy)]);
      rows.push(['Patient names excluded from export', yn(cfg.processing.excludePatientNames)]);
      rows.push(['Identical duplicate rows collapsed', yn(cfg.processing.deduplicateIdenticalRows)]);
      rows.push([]);

      rows.push(SEC(['SOURCE FILES']));
      rows.push(HDR(['File', 'Worksheet', 'Header row', 'Data rows']));
      for (var i = 0; i < state.sources.length; i++) {
        var s = state.sources[i];
        rows.push([s.fileName, s.sheetName, s.headerRowIndex === undefined ? '' : s.headerRowIndex + 1, s.rows.length]);
      }
      rows.push([]);

      rows.push(SEC(['FIELD MAPPING']));
      rows.push(HDR(['Canonical field', 'Requirement', 'Source column', 'Match basis', 'Confidence']));
      var fields = UR.headerMapper.FIELDS;
      for (var f = 0; f < fields.length; f++) {
        var m = state.mapping[fields[f].key];
        rows.push([fields[f].label, fields[f].requirement, m ? m.header : '(not provided)',
          m ? m.basis : '', m ? m.confidence : '']);
      }
      rows.push([]);

      rows.push(SEC(['PROCESSING COUNTS']));
      for (var l = 0; l < state.summaryLines.length; l++) { rows.push([state.summaryLines[l]]); }
      rows.push([]);

      rows.push(SEC(['ACTIVE THRESHOLDS']));
      rows.push(HDR(['Setting', 'Value']));
      rows.push(['Acute target hours', cfg.thresholds.acuteTargetHours]);
      rows.push(['Acute target days', cfg.thresholds.acuteTargetDays]);
      rows.push(['Observation thresholds (hours)', cfg.thresholds.obsThresholdHours.join(', ')]);
      rows.push(['One-day stay ceiling (hours)', cfg.thresholds.oneDayStayHours]);
      rows.push(['Short-stay midnight threshold', cfg.thresholds.shortStayMidnights]);
      rows.push(['MOON screening threshold (hours)', cfg.thresholds.moonThresholdHours]);
      rows.push(['Readmission windows (days)', cfg.thresholds.readmissionWindowDays.join(', ')]);
      rows.push(['Maximum transition gap (minutes)', cfg.transition.maxGapMinutes]);
      rows.push(['Overlap tolerance (minutes)', cfg.transition.overlapToleranceMinutes]);
      rows.push(['Same calendar date required', yn(cfg.transition.requireSameCalendarDate)]);
      rows.push(['Suspicious gap threshold (minutes)', cfg.transition.suspiciousGapMinutes]);
      rows.push([]);
      rows.push(NOTE(['This workbook contains no macros and no external links. It was generated entirely on this workstation with no network access.']));
      return makeSheet(rows, { maxWidth: 60 });
    },

    /* ------------------------------------------------------------ Contents */
    contents: function (state, sheetList) {
      var rows = [];
      rows.push(TITLE(['CPSI Utilization Review Data Compiler - Compiled Workbook']));
      rows.push(['Reporting period', state.period.label]);
      rows.push(['Generated', state.generatedAtText || '']);
      rows.push(['Application / ruleset / configuration version',
        UR.APP_VERSION + ' / ' + UR.RULESET_VERSION + ' / ' + state.config.configVersion]);
      rows.push(NOTE(['Regulatory figures are surveillance aids, not official compliance reporting. Validate against hospital policy and current payer/CMS requirements.']));
      rows.push([]);
      rows.push(HDR(['Worksheet', 'Group', 'What it contains']));
      for (var i = 0; i < sheetList.length; i++) {
        rows.push([C(sheetList[i].name, 'link'), sheetList[i].group, sheetList[i].desc]);
      }
      rows.push([]);
      rows.push(NOTE(['Each worksheet name above is a link. Sheet tabs are color-grouped: blue summaries, orange review work, slate account detail, amber data quality, green reference.']));

      var ws = makeSheet(rows, { maxWidth: 90, zebra: false });
      var X = xlsx();
      for (var l = 0; l < sheetList.length; l++) {
        var addr = X.utils.encode_cell({ r: 7 + l, c: 0 });
        if (ws[addr]) { ws[addr].l = { Target: "#'" + sheetList[l].name + "'!A1" }; }
      }
      return ws;
    },

    /*
     * Assemble the workbook. Returns { workbook, freezeRows, plan }:
     * freezeRows maps 1-based worksheet position to frozen header rows (kept
     * for compatibility), and plan is the full per-sheet styling plan the
     * zip patcher applies - tab colors, styled rows, severity cells, zebra.
     */
    build: function (state, generatedAtText) {
      var X = xlsx();
      state.generatedAtText = generatedAtText || '';

      var TAB = {
        Summary: 'FF2A78D6', Review: 'FFEB6834', Detail: 'FF5B6B7B',
        Quality: 'FFEDA100', Reference: 'FF1BAF7A'
      };

      var sheets = [
        { name: 'Executive Summary', group: 'Summary', freeze: 0, ws: workbookBuilder.executiveSummary(state),
          desc: 'Every headline metric with its Rule ID. Carries no patient identifiers.' },
        { name: 'Monthly Trends', group: 'Summary', freeze: 1, ws: workbookBuilder.monthlyTrends(state),
          desc: 'The same metrics month by month, including payer mix.' },
        { name: 'Review Queue', group: 'Review', freeze: 1, ws: workbookBuilder.reviewQueue(state),
          desc: 'One row per review reason; filter by Rule ID. No clinical conclusions.' },
        { name: 'Review by Account', group: 'Review', freeze: 1, ws: workbookBuilder.reviewQueueByAccount(state),
          desc: 'One row per account with every review reason attached.' },
        { name: 'Inpatient Detail', group: 'Detail', freeze: 1, ws: workbookBuilder.detailSheet(state, UR.SERVICE.IP),
          desc: 'Every acute inpatient account: LOS, thresholds, links, and flags.' },
        { name: 'Observation Detail', group: 'Detail', freeze: 1, ws: workbookBuilder.detailSheet(state, UR.SERVICE.OS),
          desc: 'Every observation account with duration thresholds and conversions.' },
        { name: 'Swing Bed Detail', group: 'Detail', freeze: 1, ws: workbookBuilder.detailSheet(state, UR.SERVICE.SB),
          desc: 'Every swing-bed account. Kept apart from the CAH acute average.' },
        { name: 'Episodes', group: 'Detail', freeze: 1, ws: workbookBuilder.episodes(state),
          desc: 'Continuous hospital episodes; internal status changes collapsed.' },
        { name: 'Transitions', group: 'Detail', freeze: 1, ws: workbookBuilder.transitions(state),
          desc: 'Every attempted status transition, accepted or refused, with reasons.' },
        { name: 'Readmissions', group: 'Detail', freeze: 1, ws: workbookBuilder.readmissions(state),
          desc: 'Potential readmission pairs. Internal indicator, not a CMS measure.' },
        { name: 'Payer Summary', group: 'Summary', freeze: 0, ws: workbookBuilder.payerSummary(state),
          desc: 'Utilization by payer category and by raw insurance code.' },
        { name: 'Disposition & Source', group: 'Summary', freeze: 0, ws: workbookBuilder.dispositionAndSource(state),
          desc: 'Dispositions, deaths, admission sources, day-of-week, LOS distribution.' },
        { name: 'Notice Review', group: 'Review', freeze: 5, ws: workbookBuilder.noticeReview(state),
          desc: 'IMM / MOON manual-check candidates. Not proof of delivery.' },
        { name: 'Data Quality', group: 'Quality', freeze: 2, ws: workbookBuilder.dataQuality(state),
          desc: 'Every diagnostic raised, summarized by rule and listed as findings.' },
        { name: 'Code Inventory', group: 'Quality', freeze: 3, ws: workbookBuilder.codeInventory(state),
          desc: 'Every distinct code encountered and exactly how it was treated.' },
        { name: 'Calculation Reference', group: 'Reference', freeze: 0, ws: workbookBuilder.calculationReference(state),
          desc: 'The full rule registry behind every number in this workbook.' },
        { name: 'Run Metadata', group: 'Reference', freeze: 0, ws: workbookBuilder.runMetadata(state),
          desc: 'Versions, source files, field mapping, and thresholds for reproducibility.' }
      ];

      var wb = X.utils.book_new();
      var freeze = {};
      var plan = { sheets: {} };
      var index = 0;

      function add(name, ws, group, headerRows) {
        X.utils.book_append_sheet(wb, ws, name);
        index++;
        if (headerRows) { freeze[index] = headerRows; }
        var spec = ws.__urStyle || { rows: {}, cells: {}, zebra: [] };
        plan.sheets[index] = {
          tab: TAB[group],
          freeze: headerRows || 0,
          rows: spec.rows,
          cells: spec.cells,
          zebra: spec.zebra
        };
        delete ws.__urStyle;
      }

      add('Contents', workbookBuilder.contents(state, sheets), 'Summary', 0);
      for (var i = 0; i < sheets.length; i++) {
        add(sheets[i].name, sheets[i].ws, sheets[i].group, sheets[i].freeze);
      }

      return { workbook: wb, freezeRows: freeze, plan: plan };
    },

    /* Build and serialize to bytes, with styling and frozen panes applied. */
    toBytes: function (state, generatedAtText) {
      var X = xlsx();
      var built = workbookBuilder.build(state, generatedAtText);
      var raw = X.write(built.workbook, { bookType: 'xlsx', type: 'array', compression: false });
      var bytes = new Uint8Array(raw);
      return UR.zipPatch.applyWorkbookPolish(bytes, built.plan);
    }
  };

  UR.workbookBuilder = workbookBuilder;

})(typeof globalThis !== 'undefined' ? globalThis : this);

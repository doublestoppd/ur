/*
 * app.js - user interface controller (spec 12).
 *
 * Plain DOM, no framework, no build step. The UI owns presentation and nothing
 * else: every number it displays comes from the pipeline, and every label comes
 * from the rule registries.
 *
 * PHI rule: imported rows live in this module's memory for the session only.
 * Nothing here writes encounter data to storage, and the only download links
 * created are object URLs for files the user explicitly asked for.
 */
(function (global) {
  'use strict';

  var UR = global.UR;
  var util = UR.util;
  var doc = global.document;

  var ui = {
    files: [],          /* { fileName, sheets } as read from disk */
    sources: [],        /* selected tables ready for the pipeline */
    selection: {},      /* canonical field key -> source header name */
    acknowledged: [],   /* required fields the user chose to proceed without */
    config: null,
    state: null,
    activeRulesTab: 'serviceCodes',
    configStatus: '',
    selectedAccount: null,
    periodTouched: false,  /* the user actually edited the period inputs */
    /*
     * Operator-entered observation segments for IP accounts (session-only,
     * never persisted): [{ account, osAdmitDT, osDischargeDT }]. Applied by
     * the pipeline on every (re)process, so they survive reprocessing and
     * vanish with the tab - PHI stays in memory.
     */
    manualObservations: []
  };

  /*
   * Two navigation groups. "Work" is where a run is read and acted on; "Setup"
   * holds the screens that only need attention when something changes. The old
   * numbered wizard implied six mandatory stops; in routine monthly use the
   * happy path is drop a file, read the Overview, work the queue, export.
   */
  var STEPS = [
    { id: 'overview', label: 'Overview', group: 'work' },
    { id: 'results', label: 'Metrics', group: 'work' },
    { id: 'review', label: 'Review Queue', group: 'work' },
    { id: 'accounts', label: 'Accounts', group: 'work' },
    { id: 'graphs', label: 'Graphs', group: 'work' },
    { id: 'export', label: 'Export', group: 'work' },
    { id: 'import', label: 'Import', group: 'setup' },
    { id: 'map', label: 'Field Mapping', group: 'setup' },
    { id: 'rules', label: 'Rules & Codes', group: 'setup' },
    { id: 'calcref', label: 'Reference', group: 'setup' }
  ];

  /* ------------------------------------------------------------- DOM helpers */

  function $(id) { return doc.getElementById(id); }

  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') { node.className = attrs[k]; }
        else if (k === 'text') { node.textContent = attrs[k]; }
        else if (k === 'html') { node.innerHTML = attrs[k]; }
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') { node.addEventListener(k.slice(2), attrs[k]); }
        else if (attrs[k] === true) { node.setAttribute(k, ''); }
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) { node.setAttribute(k, attrs[k]); }
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) { return; }
      node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  function table(headers, rows, options) {
    var opts = options || {};
    var thead = el('thead', null, [el('tr', null, headers.map(function (h) {
      return el('th', { class: opts.numeric && opts.numeric.indexOf(h) >= 0 ? 'num' : null }, [String(h)]);
    }))]);
    var tbody = el('tbody', null, rows.map(function (r) {
      return el('tr', null, r.map(function (cell) {
        if (cell && cell.nodeType) { return el('td', null, [cell]); }
        var text = cell === null || cell === undefined ? '' : String(cell);
        return el('td', { class: typeof cell === 'number' ? 'num' : null }, [text]);
      }));
    }));
    var t = el('table', null, [thead, tbody]);
    return el('div', { class: opts.scroll ? 'scroll-box' : 'table-wrap' }, [t]);
  }

  function pill(text, kind) { return el('span', { class: 'pill pill-' + kind, text: text }); }

  function num(v, places) {
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) { return '-'; }
    return String(util.round(v, places === undefined ? 2 : places));
  }

  function pct(v) { return v === null || v === undefined ? '-' : util.round(v, 1) + '%'; }

  /* A count with its share of the whole on one line: "12 (34.5%)". */
  function withPct(count, pctValue) {
    if (count === null || count === undefined) { return '-'; }
    if (pctValue === null || pctValue === undefined) { return String(count); }
    return count + ' (' + util.round(pctValue, 1) + '%)';
  }

  /* ------------------------------------------------------------- navigation */

  function showStep(id) {
    STEPS.forEach(function (s) {
      var node = $('step-' + s.id);
      if (node) { node.hidden = s.id !== id; }
    });
    renderNav(id);
    if (global.scrollTo) { global.scrollTo(0, 0); }
  }

  function stepAvailable(id) {
    if (id === 'import') { return true; }
    if (id === 'calcref') { return true; }
    if (id === 'map' || id === 'rules') { return ui.sources.length > 0; }
    if (id === 'overview') { return !!ui.state || ui.sources.length > 0; }
    return !!ui.state && !ui.state.blocked;
  }

  function renderNav(active) {
    var nav = $('step-nav');
    clear(nav);
    var lastGroup = null;
    STEPS.forEach(function (s) {
      if (lastGroup && s.group !== lastGroup) {
        nav.appendChild(el('span', { class: 'nav-sep', 'aria-hidden': 'true' }));
        nav.appendChild(el('span', { class: 'nav-group-label', text: 'Setup' }));
      }
      lastGroup = s.group;
      var available = stepAvailable(s.id) || s.id === active;
      nav.appendChild(el('button', {
        type: 'button',
        'data-step': s.id,
        class: (s.id === active ? 'active ' : '') + 'nav-' + s.group,
        disabled: available ? null : true,
        onclick: function () { if (available) { goTo(s.id); } }
      }, [s.label]));
    });
  }

  function goTo(id) {
    /*
     * Reveal the section before rendering into it. A hidden section has zero
     * width, so anything that measures its container - the charts especially -
     * would lay itself out against nothing.
     */
    showStep(id);
    if (id === 'map') { renderMapping(); }
    if (id === 'rules') { renderRules(); }
    if (id === 'overview') { renderOverview(); }
    if (id === 'results') { renderResults(); }
    if (id === 'review') { renderReview(); }
    if (id === 'accounts') { renderAccounts(); }
    if (id === 'graphs') { renderGraphs(); }
    if (id === 'export') { renderExport(); }
    if (id === 'calcref') { renderCalcRef(); }
  }

  /* --------------------------------------------------------- rule links */

  /*
   * Every displayed rule label is a jump into the Calculation Reference:
   * the reference opens filtered to that id, with the exact rule first and
   * highlighted. One implementation, used by every screen that shows an id.
   */
  function openRuleReference(id) {
    $('calcref-filter').value = id;
    $('calcref-group').value = '';
    goTo('calcref');
  }

  function ruleExists(id) {
    return !!(UR.calculationRules.byId(id) || UR.reviewRules.byId(id) || UR.dataQualityRules.byId(id));
  }

  function ruleLink(id, className) {
    if (!id) { return null; }
    /* A wildcard like "RQ_OS_*" is a family, not a rule: leave it plain. */
    if (!ruleExists(id)) { return el('code', { class: className || null, text: id }); }
    return el('button', {
      type: 'button',
      class: 'rule-link' + (className ? ' ' + className : ''),
      title: 'Open ' + id + ' in the Calculation Reference',
      onclick: function () { openRuleReference(id); }
    }, [id]);
  }

  /*
   * An account number is always a jump to that account's full course in the
   * Accounts view. Works from anywhere, including inside a modal - the modal
   * is closed first.
   */
  function accountLink(account) {
    var text = account === null || account === undefined ? '' : String(account);
    if (!text) { return doc.createTextNode(''); }
    return el('button', {
      type: 'button', class: 'account-link',
      title: 'Open account ' + text + ' in the Accounts view',
      onclick: function () { closeModal(); openAccount(text); }
    }, [text]);
  }

  /* A list of account numbers -> a span of individual account links. */
  function accountLinkList(accounts) {
    var list = Object.prototype.toString.call(accounts) === '[object Array]'
      ? accounts : String(accounts || '').split(',');
    var wrap = el('span');
    var first = true;
    list.forEach(function (a) {
      var text = String(a).trim();
      if (!text) { return; }
      if (!first) { wrap.appendChild(doc.createTextNode(', ')); }
      first = false;
      wrap.appendChild(accountLink(text));
    });
    return wrap;
  }

  /* "IP_GT4_001, RQ_IP_GT4" -> a span of individual rule links. */
  function ruleLinkList(text) {
    var wrap = el('span');
    String(text).split(',').forEach(function (part, index) {
      var id = part.trim();
      if (index > 0) { wrap.appendChild(doc.createTextNode(', ')); }
      wrap.appendChild(ruleLink(id) || doc.createTextNode(id));
    });
    return wrap;
  }

  /* ----------------------------------------------------------------- modal */

  function openModal(title, bodyNode) {
    $('modal-title').textContent = title;
    var body = $('modal-body');
    clear(body);
    body.appendChild(bodyNode);
    $('modal-backdrop').hidden = false;
  }

  function closeModal() { $('modal-backdrop').hidden = true; }

  /* ------------------------------------------------------- 1. file import */

  function readFile(file) {
    return new global.Promise(function (resolve) {
      var reader = new global.FileReader();
      reader.onload = function (ev) {
        var data = new global.Uint8Array(ev.target.result);
        /* A workbook this tool exported carries a session snapshot; restore
         * beats re-parsing its formatted sheets as data. */
        var snapshot = UR.zipPatch.extractSnapshot(data);
        if (snapshot) {
          resolve({ fileName: file.name, snapshot: snapshot, error: null, sheets: [] });
          return;
        }
        /* A PDF is expected to be the CPSI Service Log (CNSERVLOG) report. */
        if (UR.pdfText.isPdf(data)) {
          var lines = UR.pdfText.extractLines(data);
          if (!lines.length) {
            resolve({ fileName: file.name, error: 'No text could be extracted from this PDF. A scanned report has no text layer; export the report from CPSI directly to PDF instead.', sheets: [] });
            return;
          }
          var log = UR.serviceLogParser.parse(lines);
          if (!log.ok) {
            resolve({ fileName: file.name, error: 'This PDF is not a recognized CPSI Service Log (CNSERVLOG) report. Only that report is supported as a PDF.', sheets: [] });
            return;
          }
          resolve({ fileName: file.name, serviceLog: log, error: null, sheets: [] });
          return;
        }
        resolve(UR.spreadsheetReader.readFile(file.name, data));
      };
      reader.onerror = function () {
        resolve({ fileName: file.name, error: 'The file could not be read from disk.', sheets: [] });
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function handleFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) { files.push(fileList[i]); }
    if (!files.length) { return; }
    var hadData = ui.sources.length > 0;
    global.Promise.all(files.map(readFile)).then(function (results) {
      var restored = false;
      results.forEach(function (r) {
        if (r.snapshot) { restored = restoreSnapshot(r) || restored; }
        else { ui.files.push(r); }
      });
      rebuildSources();
      renderFileList();
      /*
       * A FIRST import gets a fresh period inference and no manual entries: a
       * range or a segment entered for a previous file set must not silently
       * apply to a new one. ADDING files to data already loaded - including
       * data restored from an exported workbook - preserves the period choice
       * and the manual observation segments, so a restored session can grow.
       */
      if (!hadData && !restored) {
        $('period-start').value = '';
        $('period-end').value = '';
        ui.periodTouched = false;
        ui.manualObservations = [];
      }
      /*
       * Deliberately NO automatic jump to the Overview: the operator may have
       * more documents to add (the Service Log PDF, a prior month for
       * readmission history), and processing half an upload invites reading
       * half the picture. The state is invalidated so whatever renders next
       * reprocesses with everything imported; the Process & review button is
       * the explicit "I am done uploading" step.
       */
      ui.state = null;
      goTo('import');
    });
  }

  /*
   * A workbook this tool exported carries a session snapshot; importing it
   * restores the tool to the state that produced it: sources, field mapping,
   * configuration, period choice, and manual observation segments. Restored
   * sources become ordinary file entries, so further files can be added on
   * top afterwards.
   */
  function restoreSnapshot(fileRecord) {
    var snap;
    try {
      snap = JSON.parse(fileRecord.snapshot);
    } catch (e) {
      ui.files.push({ fileName: fileRecord.fileName, error: 'The embedded session snapshot is not readable JSON.', sheets: [] });
      return false;
    }
    if (!snap || snap.kind !== 'ur-compiler-snapshot' || !snap.sources || !snap.sources.length) {
      ui.files.push({ fileName: fileRecord.fileName, error: 'The embedded session snapshot is incomplete.', sheets: [] });
      return false;
    }

    var cfg = UR.configSchema.validate(snap.config || {});
    if (cfg.ok) {
      ui.config = cfg.config;
      ui.configStatus = 'Configuration restored from the workbook snapshot.';
    }

    snap.sources.forEach(function (s) {
      ui.files.push({
        fileName: s.fileName,
        restored: true,
        error: null,
        selectedSheetName: s.sheetName,
        sheets: [{
          name: s.sheetName,
          headers: s.headers,
          rows: s.rows.map(function (r) { return { cells: r.c, sourceRowNumber: r.n }; }),
          headerRowIndex: s.headerRowIndex,
          rowCount: s.rows.length,
          excelGuardCells: 0
        }]
      });
    });

    ui.selection = snap.selection || {};
    ui.acknowledged = snap.acknowledged || [];
    ui.autoResult = null;
    $('period-start').value = (snap.period && snap.period.start) || '';
    $('period-end').value = (snap.period && snap.period.end) || '';
    ui.periodTouched = !!(snap.period && snap.period.touched);
    ui.manualObservations = (snap.manualObservations || []).map(function (m) {
      return { account: m.account, osAdmitDT: new Date(m.osAdmit), osDischargeDT: new Date(m.osDischarge) };
    });
    (snap.serviceLogs || []).forEach(function (s) {
      ui.files.push({
        fileName: s.fileName,
        restored: true,
        error: null,
        sheets: [],
        serviceLog: {
          ok: true,
          reportRange: s.reportRange || '',
          facility: s.facility || '',
          rows: (s.rows || []).map(function (r) {
            return { account: r.account, name: r.name, from: r.from, to: r.to,
                     changeDT: r.change ? new Date(r.change) : null,
                     rawDate: r.rawDate, rawTime: r.rawTime, initials: r.initials };
          }),
          unparsed: s.unparsed || []
        }
      });
    });
    ui.state = null;
    return true;
  }

  /*
   * The Process & review button: validates the mapping and moves on. The
   * mapping screen appears only when the mapper actually needs a human
   * decision - a required column missing or two columns equally plausible.
   * Import never advances on its own; the operator says when the pile of
   * documents is complete.
   */
  function tryAutoProcess() {
    if (!ui.sources.length) { return; }
    var validation = UR.headerMapper.validateMapping(ui.sources[0].mapping, ui.acknowledged);
    var ambiguous = ui.autoResult && ui.autoResult.ambiguities.length > 0;
    if (validation.ok && !ambiguous) {
      ui.state = null;
      goTo('overview');
    } else {
      goTo('map');
    }
  }

  /* Pick one data sheet per file and apply the current field selection. */
  function rebuildSources() {
    ui.sources = [];
    ui.files.forEach(function (file) {
      if (file.error || !file.sheets.length) { return; }
      var sheet = file.selectedSheetName
        ? file.sheets.filter(function (s) { return s.name === file.selectedSheetName; })[0]
        : UR.spreadsheetReader.pickDataSheet(file.sheets);
      if (!sheet) { return; }
      file.selectedSheetName = sheet.name;
      ui.sources.push({
        fileName: file.fileName,
        sheetName: sheet.name,
        headers: sheet.headers,
        rows: sheet.rows,
        headerRowIndex: sheet.headerRowIndex,
        excelGuardCells: sheet.excelGuardCells || 0,
        mapping: {}
      });
    });

    if (ui.sources.length && !Object.keys(ui.selection).length) {
      var auto = UR.headerMapper.autoMap(ui.sources[0].headers);
      UR.headerMapper.FIELDS.forEach(function (f) {
        ui.selection[f.key] = auto.mapping[f.key] ? auto.mapping[f.key].header : null;
      });
      ui.autoResult = auto;
    }
    applySelection();
  }

  /* Resolve the header-name selection into per-source column indexes. */
  function applySelection() {
    ui.sources.forEach(function (source) {
      var auto = UR.headerMapper.autoMap(source.headers);
      var mapping = {};
      UR.headerMapper.FIELDS.forEach(function (f) {
        var header = ui.selection[f.key];
        if (!header) { mapping[f.key] = null; return; }
        var index = source.headers.indexOf(header);
        if (index < 0) {
          /* A second file with different headers: fall back to its own automap. */
          mapping[f.key] = auto.mapping[f.key] || null;
          return;
        }
        var autoEntry = auto.mapping[f.key];
        mapping[f.key] = {
          header: header,
          index: index,
          confidence: autoEntry && autoEntry.header === header ? autoEntry.confidence : 0,
          basis: autoEntry && autoEntry.header === header ? autoEntry.basis : 'Chosen by user'
        };
      });
      source.mapping = mapping;
    });
  }

  function detectedRange(source) {
    var mapping = source.mapping;
    if (!mapping.admitDate) { return ''; }
    var min = null, max = null;
    source.rows.forEach(function (row) {
      var res = UR.parsers.parseDate(UR.spreadsheetReader.cellFor(row, mapping, 'admitDate'));
      if (!res.ok) { return; }
      if (!min || res.value < min) { min = res.value; }
      if (!max || res.value > max) { max = res.value; }
    });
    return min ? util.fmtDate(min) + ' - ' + util.fmtDate(max) : '';
  }

  function renderFileList() {
    var host = $('file-list');
    clear(host);

    ui.files.forEach(function (file, index) {
      var card = el('div', { class: 'file-card' });
      card.appendChild(el('div', { class: 'file-name' }, [
        doc.createTextNode(file.fileName + ' '),
        file.restored ? pill('Restored from exported workbook', 'info') : null
      ]));

      if (file.error) {
        card.appendChild(el('div', { class: 'msg msg-error', text: file.error }));
      } else if (file.serviceLog) {
        var osip = file.serviceLog.rows.filter(function (r) { return r.from === 'OS' && r.to === 'IP'; });
        var others = file.serviceLog.rows.length - osip.length;
        card.appendChild(el('div', { class: 'file-meta', text:
          'CPSI Service Log (CNSERVLOG)' +
          (file.serviceLog.reportRange ? ' | ' + file.serviceLog.reportRange : '') +
          ' | ' + osip.length + ' OS -> IP change(s)' +
          (others ? ' | ' + others + ' row(s) with other service pairs, not applied' : '') +
          (file.serviceLog.unparsed.length ? ' | ' + file.serviceLog.unparsed.length + ' line(s) not readable as rows' : '') }));
        card.appendChild(el('div', { class: 'muted', text:
          'Each OS -> IP row becomes an observation segment on the matching inpatient account: ' +
          'an <account>-SRVCLOG observation account from the account\'s admission to the change moment, with the inpatient admission moved to the change moment. ' +
          'Rows without a matching imported IP account are reported after processing.' }));
      } else {
        var source = ui.sources.filter(function (s) { return s.fileName === file.fileName; })[0];
        var meta = el('div', { class: 'file-meta' });
        if (file.sheets.length > 1) {
          var select = el('select', {
            onchange: function (ev) {
              file.selectedSheetName = ev.target.value;
              rebuildSources();
              renderFileList();
            }
          }, file.sheets.map(function (s) {
            return el('option', { value: s.name, selected: s.name === file.selectedSheetName ? true : null },
              [s.name + ' (' + s.rowCount + ' rows)']);
          }));
          meta.appendChild(doc.createTextNode('Worksheet: '));
          meta.appendChild(select);
        } else if (source) {
          meta.appendChild(doc.createTextNode('Worksheet: ' + source.sheetName));
        }
        if (source) {
          var range = detectedRange(source);
          meta.appendChild(doc.createTextNode(
            ' | ' + source.rows.length + ' data rows | ' + source.headers.length + ' columns' +
            (range ? ' | admissions ' + range : '')));
        }
        card.appendChild(meta);
        if (source) {
          card.appendChild(el('div', { class: 'muted', text: 'Detected headers: ' + source.headers.join(', ') }));
        }
      }

      card.appendChild(el('button', {
        type: 'button', class: 'link',
        onclick: function () {
          ui.files.splice(index, 1);
          ui.selection = {};
          ui.state = null;
          $('period-start').value = '';
          $('period-end').value = '';
          ui.periodTouched = false;
          rebuildSources();
          renderFileList();
        }
      }, ['Remove file']));
      host.appendChild(card);
    });

    $('btn-to-mapping').disabled = ui.sources.length === 0;
    $('btn-adjust-mapping').hidden = ui.sources.length === 0;
    renderImportSummary();
    renderNav('import');
  }

  /*
   * What has been imported so far, aggregated: total rows and the admission
   * span across every spreadsheet, plus the service-log changes. Rendered on
   * every file change so the operator can see whether the pile is complete
   * BEFORE pressing Process & review.
   */
  function renderImportSummary() {
    var host = $('import-summary');
    clear(host);
    if (!ui.files.length) { return; }

    var totalRows = 0;
    var minAdmit = null, maxAdmit = null;
    ui.sources.forEach(function (source) {
      totalRows += source.rows.length;
      if (!source.mapping.admitDate) { return; }
      source.rows.forEach(function (row) {
        var res = UR.parsers.parseDate(UR.spreadsheetReader.cellFor(row, source.mapping, 'admitDate'));
        if (!res.ok) { return; }
        if (!minAdmit || res.value < minAdmit) { minAdmit = res.value; }
        if (!maxAdmit || res.value > maxAdmit) { maxAdmit = res.value; }
      });
    });

    var logs = ui.files.filter(function (f) { return f.serviceLog; });
    var logChanges = 0;
    var logRanges = [];
    logs.forEach(function (f) {
      logChanges += f.serviceLog.rows.filter(function (r) { return r.from === 'OS' && r.to === 'IP'; }).length;
      if (f.serviceLog.reportRange) { logRanges.push(f.serviceLog.reportRange); }
    });

    var parts = [];
    if (ui.sources.length) {
      parts.push(ui.sources.length + ' spreadsheet file(s), ' + totalRows + ' data row(s)' +
        (minAdmit ? ', admissions spanning ' + util.fmtDate(minAdmit) + ' - ' + util.fmtDate(maxAdmit) : ''));
    }
    if (logs.length) {
      parts.push(logs.length + ' Service Log report(s) with ' + logChanges + ' OS -> IP change(s)' +
        (logRanges.length ? ' covering ' + logRanges.join('; ') : ''));
    }
    var errored = ui.files.filter(function (f) { return f.error; }).length;
    if (errored) { parts.push(errored + ' file(s) could not be read - see the cards above'); }

    host.appendChild(el('div', { class: 'import-summary' }, [
      el('strong', { text: 'Imported so far: ' }),
      doc.createTextNode(parts.join('  |  ') || 'nothing usable yet'),
      el('span', { class: 'hint', text: '  Nothing is processed until Process & review is pressed - add everything first.' })
    ]));
  }

  /* --------------------------------------------------------- 2. field map */

  function sampleValues(fieldKey) {
    var source = ui.sources[0];
    if (!source || !source.mapping[fieldKey]) { return ''; }
    var seen = [];
    for (var i = 0; i < source.rows.length && seen.length < 3; i++) {
      var v = UR.spreadsheetReader.cellFor(source.rows[i], source.mapping, fieldKey);
      if (v === null || v === undefined || String(v).trim() === '') { continue; }
      var text = String(v);
      if (seen.indexOf(text) < 0) { seen.push(text); }
    }
    return seen.join(', ');
  }

  function renderMapping() {
    var messages = $('mapping-messages');
    clear(messages);

    var validation = UR.headerMapper.validateMapping(ui.sources.length ? ui.sources[0].mapping : {}, ui.acknowledged);
    var ambiguities = ui.autoResult ? ui.autoResult.ambiguities : [];

    ambiguities.forEach(function (a) {
      messages.appendChild(el('div', { class: 'msg msg-warning' }, [
        el('strong', { text: 'Ambiguous header - choose manually' }),
        doc.createTextNode(a.reason + ' Candidates: ' + a.columns.join(', ') + '.')
      ]));
    });
    validation.blocking.forEach(function (b) {
      messages.appendChild(el('div', { class: 'msg msg-blocking' }, [
        el('strong', { text: 'Blocking' }), doc.createTextNode(b.message)
      ]));
    });
    validation.warnings.forEach(function (w) {
      messages.appendChild(el('div', { class: 'msg msg-warning' }, [
        el('strong', { text: 'Limited capability' }), doc.createTextNode(w.message)
      ]));
    });

    var headers = ui.sources.length ? ui.sources[0].headers : [];
    var host = $('mapping-body');
    clear(host);

    var thead = el('thead', null, [el('tr', null,
      ['Canonical field', 'Requirement', 'CPSI field', 'Source column', 'Match', 'Sample values', 'Used for']
        .map(function (h) { return el('th', { text: h }); }))]);

    var body = el('tbody');
    UR.headerMapper.FIELDS.forEach(function (field) {
      var current = ui.sources.length ? ui.sources[0].mapping[field.key] : null;

      var select = el('select', {
        onchange: function (ev) {
          ui.selection[field.key] = ev.target.value || null;
          applySelection();
          ui.state = null;
          renderMapping();
        }
      }, [el('option', { value: '' }, ['Not provided'])].concat(headers.map(function (h) {
        return el('option', { value: h, selected: current && current.header === h ? true : null }, [h]);
      })));

      var requirementCell = el('td');
      requirementCell.appendChild(doc.createTextNode(field.requirement));
      if (!current && field.requirement === 'required' && field.degradable) {
        var ack = el('label', { class: 'checkbox' }, [
          el('input', {
            type: 'checkbox',
            checked: util.contains(ui.acknowledged, field.key) ? true : null,
            onchange: function (ev) {
              if (ev.target.checked) { ui.acknowledged.push(field.key); }
              else { ui.acknowledged = ui.acknowledged.filter(function (k) { return k !== field.key; }); }
              renderMapping();
            }
          }),
          doc.createTextNode(' Proceed without it')
        ]);
        requirementCell.appendChild(ack);
      }

      var matchText = current
        ? current.basis + (current.confidence ? ' (' + Math.round(current.confidence * 100) + '%)' : '')
        : '-';

      var row = el('tr');
      row.appendChild(el('td', null, [el('strong', { text: field.label })]));
      row.appendChild(requirementCell);
      row.appendChild(el('td', null, [el('code', { text: field.cpsi || '(not established)' })]));
      row.appendChild(el('td', null, [select]));
      row.appendChild(el('td', { text: matchText }));
      row.appendChild(el('td', { class: 'muted', text: sampleValues(field.key) }));
      row.appendChild(el('td', { class: 'muted', text: current ? field.use : field.degradedEffect || field.use }));
      body.appendChild(row);
    });

    var wrapped = el('div', { class: 'table-wrap' }, [el('table', null, [thead, body])]);

    /*
     * On a clean run the table is reference material, not a task: lead with the
     * one line that matters and keep the full assignment list one click away.
     * Any ambiguity, blocker, or degraded capability keeps the table open.
     */
    var clean = validation.ok && !validation.blocking.length &&
                !validation.warnings.length && !ambiguities.length;
    if (clean) {
      var mappedCount = 0;
      UR.headerMapper.FIELDS.forEach(function (f) {
        if (ui.sources.length && ui.sources[0].mapping[f.key]) { mappedCount++; }
      });
      host.appendChild(el('p', { class: 'attn-ok', text:
        'Every column resolved: ' + mappedCount + ' of ' + UR.headerMapper.FIELDS.length +
        ' canonical fields matched, nothing needs a decision.' }));
      var d = el('details', { class: 'fold', open: ui.mappingFoldOpen ? true : null }, [
        el('summary', null, ['Show every field assignment']),
        el('div', { class: 'fold-body' }, [wrapped])
      ]);
      d.addEventListener('toggle', function () { ui.mappingFoldOpen = d.open; });
      host.appendChild(d);
    } else {
      host.appendChild(wrapped);
    }

    $('btn-to-rules').disabled = !validation.ok;
  }

  /* ------------------------------------------------------- 3. rules & codes */

  var RULES_TABS = [
    { key: 'serviceCodes', label: 'Service codes' },
    { key: 'dischargeCodes', label: 'Discharge codes' },
    { key: 'insuranceCodes', label: 'Insurance / payer codes' },
    { key: 'admissionSources', label: 'Admission sources' },
    { key: 'transition', label: 'Transition settings' },
    { key: 'thresholds', label: 'Review thresholds' },
    { key: 'processing', label: 'Processing options' }
  ];

  /* Exact-case counts of the raw values in the loaded data for one field. */
  function rawValueCounts(fieldKey) {
    var counts = {};
    ui.sources.forEach(function (source) {
      source.rows.forEach(function (row) {
        var v = util.codeExact(UR.parsers.parseText(
          UR.spreadsheetReader.cellFor(row, source.mapping, fieldKey)));
        if (v === '') { return; }
        counts[v] = (counts[v] || 0) + 1;
      });
    });
    return counts;
  }

  /*
   * Attribute those values to the reference rows through the same lookup the
   * engine uses, so the "rows in data" column and the unmapped notice can never
   * disagree with what processing actually did. Keying by upper-cased code -
   * the previous behaviour - pooled the counts of case pairs like DCg/DCG onto
   * both rows, and reported a numeric origin column ("1" vs table code "01") as
   * unmapped even though the engine resolves it.
   */
  function attributedCounts(fieldKey, listKey) {
    return util.attributeCounts(ui.config[listKey], rawValueCounts(fieldKey));
  }

  function renderRules() {
    /* The last state known to pass validation, for rolling a bad edit back. */
    ui.configSnapshot = util.clone(ui.config);

    var tabs = $('rules-tabs');
    clear(tabs);
    RULES_TABS.forEach(function (t) {
      tabs.appendChild(el('button', {
        type: 'button',
        class: ui.activeRulesTab === t.key ? 'active' : '',
        onclick: function () { ui.activeRulesTab = t.key; renderRules(); }
      }, [t.label]));
    });

    var panel = $('rules-panel');
    clear(panel);
    var tab = ui.activeRulesTab;

    if (tab === 'serviceCodes') { panel.appendChild(renderServiceCodes()); }
    else if (tab === 'dischargeCodes') { panel.appendChild(renderDischargeCodes()); }
    else if (tab === 'insuranceCodes') { panel.appendChild(renderInsuranceCodes()); }
    else if (tab === 'admissionSources') { panel.appendChild(renderAdmissionSources()); }
    else if (tab === 'transition') { panel.appendChild(renderTransitionSettings()); }
    else if (tab === 'thresholds') { panel.appendChild(renderThresholds()); }
    else { panel.appendChild(renderProcessing()); }

    $('config-status').textContent = ui.configStatus;
  }

  /*
   * Apply an edit made in the rules tables.
   *
   * The editors write straight into the configuration object, so the same
   * schema that guards an imported JSON file has to guard them too - otherwise
   * the UI is a way around it. An edit that fails validation is rolled back to
   * the last good state and the reason is shown, rather than being half-applied
   * and surfacing later as a broken metric.
   */
  function markConfigChanged(message) {
    var check = UR.configSchema.validate(JSON.parse(UR.configSchema.toJSON(ui.config, '')));
    if (!check.ok) {
      if (ui.configSnapshot) { ui.config = util.clone(ui.configSnapshot); }
      ui.configStatus = 'Change not applied: ' + check.errors.join(' ');
      renderRules();
      return;
    }
    UR.configSchema.bumpVersion(ui.config);
    ui.state = null;
    ui.configStatus = message || ('Configuration version ' + ui.config.configVersion + ' (unsaved).');
    renderRules();
  }

  function unmappedNotice(att, listKey, factory) {
    var addable = att.unmatched.filter(function (u) { return !u.ambiguous; });
    var ambiguous = att.unmatched.filter(function (u) { return u.ambiguous; });
    if (!addable.length && !ambiguous.length) { return null; }

    var parts = [];
    if (addable.length) {
      parts.push(el('strong', { text: addable.length + ' value(s) in the loaded data are not mapped' }));
      parts.push(doc.createTextNode(addable.map(function (u) { return u.value; }).join(', ') + '. '));
      parts.push(el('button', {
        type: 'button', class: 'link',
        onclick: function () {
          addable.forEach(function (u) { ui.config[listKey].push(factory(u.value)); });
          markConfigChanged('Added ' + addable.length + ' unmapped value(s) for editing.');
        }
      }, ['Add them for editing']));
    }
    if (ambiguous.length) {
      /* Adding a new row here is precisely the wrong repair: the value already
       * half-matches several existing codes, and a new row would shadow them. */
      parts.push(el('div', { class: 'muted' }, [
        doc.createTextNode('Also ' + ambiguous.length + ' value(s) matching more than one existing code once case or leading zeros are ignored: ' +
          ambiguous.map(function (u) { return u.value; }).join(', ') +
          '. Correct the export or the existing rows rather than adding new ones.')
      ]));
    }
    return el('div', { class: 'msg msg-warning' }, parts);
  }

  function renderServiceCodes() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'IP, OS, and SB are included by default. Every other code is excluded; mark a code as Ignore to record that the exclusion is intentional rather than an unknown.' }));
    var att = attributedCounts('service', 'serviceCodes');
    var notice = unmappedNotice(att, 'serviceCodes', function (code) {
      return { code: code, label: '', behavior: UR.SERVICE.IGNORED, enabled: true };
    });
    if (notice) { wrap.appendChild(notice); }

    var rows = ui.config.serviceCodes.map(function (row, i) {
      return [
        editText(row, 'code', function () { markConfigChanged(); }),
        editText(row, 'label', function () { markConfigChanged(); }),
        editSelect(row, 'behavior', [
          { value: UR.SERVICE.IP, label: 'Include as IP (acute inpatient)' },
          { value: UR.SERVICE.OS, label: 'Include as OS (observation)' },
          { value: UR.SERVICE.SB, label: 'Include as SB (swing bed)' },
          { value: UR.SERVICE.IGNORED, label: 'Explicitly ignore' }
        ], function () { markConfigChanged(); }),
        att.byCode[util.codeExact(row.code)] || 0,
        editCheckbox(row, 'enabled', function () { markConfigChanged(); }),
        removeButton('serviceCodes', i)
      ];
    });
    wrap.appendChild(table(['Code', 'Label', 'Behavior', 'Rows in data', 'Enabled', ''], rows, { numeric: ['Rows in data'] }));
    wrap.appendChild(addButton('serviceCodes', function () {
      return { code: '', label: '', behavior: UR.SERVICE.IGNORED, enabled: true };
    }));
    return wrap;
  }

  function renderDischargeCodes() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'A transition target means the code implies an internal status change and a following account of that service. The published meaning of a code is kept in the label even when the hospital assigns a local workflow interpretation.' }));
    var att = attributedCounts('dischargeCode', 'dischargeCodes');
    var notice = unmappedNotice(att, 'dischargeCodes', function (code) {
      return { code: code, label: '', category: 'Other', transitionTo: null, enabled: true };
    });
    if (notice) { wrap.appendChild(notice); }

    var categories = UR.defaultMappings.DISCHARGE_CATEGORIES.map(function (c) { return { value: c, label: c }; });
    var targets = [{ value: '', label: 'None (true discharge)' }].concat(
      UR.INCLUDED_SERVICES.map(function (s) { return { value: s, label: 'Internal transition to ' + s }; }));

    var rows = ui.config.dischargeCodes.map(function (row, i) {
      return [
        editText(row, 'code', function () { markConfigChanged(); }),
        editText(row, 'label', function () { markConfigChanged(); }),
        editSelect(row, 'category', categories, function () { markConfigChanged(); }),
        editSelect(row, 'transitionTo', targets, function () {
          if (!row.transitionTo) { row.transitionTo = null; }
          markConfigChanged();
        }),
        row.transitionFrom ? row.transitionFrom.join(', ') : 'any',
        att.byCode[util.codeExact(row.code)] || 0,
        editCheckbox(row, 'enabled', function () { markConfigChanged(); }),
        removeButton('dischargeCodes', i)
      ];
    });
    wrap.appendChild(table(['Code', 'Label', 'Disposition category', 'Transition target', 'Only from', 'Rows in data', 'Enabled', ''], rows, { numeric: ['Rows in data'] }));
    wrap.appendChild(addButton('dischargeCodes', function () {
      return { code: '', label: '', category: 'Other', transitionTo: null, enabled: true };
    }));
    wrap.appendChild(el('p', { class: 'hint', text: 'The death category used by DEATH_001 is "' + ui.config.deathCategory + '".' }));
    return wrap;
  }

  /*
   * The insurance table carries 736 codes, so it is filtered rather than dumped:
   * rendering every row as editable inputs would be unusable, and the rows that
   * matter are the ones that actually appear in the loaded data.
   */
  var INSURANCE_RENDER_LIMIT = 250;

  function renderInsuranceCodes() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text:
      'Codes, names, and payer categories come from the hospital mapping. Payer category drives the Medicare notice and two-midnight review rules; ' +
      'an unmapped code reports as Unknown and is excluded from those rules rather than being guessed. ' +
      'Codes are CASE-SENSITIVE: this table contains pairs such as DCg and DCG that differ only in case and mean different payers. ' +
      'Rows the hospital marks Do Not Use are shipped disabled, so one appearing on a current account is reported rather than absorbed.' }));
    var att = attributedCounts('insurance', 'insuranceCodes');
    var notice = unmappedNotice(att, 'insuranceCodes', UR.defaultMappings.blankInsurance);
    if (notice) { wrap.appendChild(notice); }

    var hasData = att.unmatched.length > 0;
    for (var k in att.byCode) { if (Object.prototype.hasOwnProperty.call(att.byCode, k)) { hasData = true; break; } }
    if (ui.insuranceOnlyPresent === undefined) { ui.insuranceOnlyPresent = hasData; }

    var controls = el('div', { class: 'filter-row' }, [
      el('input', {
        type: 'search', value: ui.insuranceFilter || '',
        placeholder: 'Filter by code or plan name',
        oninput: function (ev) { ui.insuranceFilter = ev.target.value; renderRules(); }
      }),
      el('label', { class: 'inline-check' }, [
        el('input', {
          type: 'checkbox', checked: ui.insuranceOnlyPresent ? true : null,
          disabled: hasData ? null : true,
          onchange: function (ev) { ui.insuranceOnlyPresent = ev.target.checked; renderRules(); }
        }),
        doc.createTextNode(' Only codes found in the loaded data')
      ]),
      el('label', { class: 'inline-check' }, [
        el('input', {
          type: 'checkbox', checked: ui.insuranceNeedsCheck ? true : null,
          onchange: function (ev) { ui.insuranceNeedsCheck = ev.target.checked; renderRules(); }
        }),
        /* These are the rows that decide the IMM, MOON, and two-midnight lists. */
        doc.createTextNode(' Only Medicare rows')
      ])
    ]);
    wrap.appendChild(controls);

    var query = String(ui.insuranceFilter || '').toLowerCase();
    var matching = [];
    ui.config.insuranceCodes.forEach(function (row, index) {
      var count = att.byCode[util.codeExact(row.code)] || 0;
      if (ui.insuranceOnlyPresent && !count) { return; }
      if (ui.insuranceNeedsCheck) {
        var medicare = row.category === UR.PAYER_CATEGORY.MEDICARE_FFS ||
                       row.category === UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE;
        if (!medicare) { return; }
      }
      if (query) {
        var hay = (row.code + ' ' + (row.label || '') + ' ' + row.category).toLowerCase();
        if (hay.indexOf(query) < 0) { return; }
      }
      matching.push({ row: row, index: index, count: count });
    });
    matching.sort(function (a, b) { return b.count - a.count; });

    var shown = matching.slice(0, INSURANCE_RENDER_LIMIT);
    wrap.appendChild(el('p', { class: 'config-status', text:
      'Showing ' + shown.length + ' of ' + matching.length + ' matching row(s), out of ' +
      ui.config.insuranceCodes.length + ' codes in the table.' +
      (matching.length > shown.length ? ' Narrow the filter to reach the rest.' : '') }));

    var categories = UR.PAYER_CATEGORY_LIST.map(function (c) { return { value: c, label: c }; });
    var rows = shown.map(function (entry) {
      var row = entry.row;
      return [
        editText(row, 'code', function () { markConfigChanged(); }),
        editText(row, 'label', function () { markConfigChanged(); }),
        editSelect(row, 'category', categories, function () { markConfigChanged(); }),
        entry.count,
        editCheckbox(row, 'enabled', function () { markConfigChanged(); }),
        row.note ? el('span', { class: 'muted', text: row.note }) : '',
        removeButton('insuranceCodes', entry.index)
      ];
    });
    wrap.appendChild(table(['Code', 'Display name', 'Payer category', 'Rows in data', 'Enabled', 'Note', ''],
      rows, { numeric: ['Rows in data'], scroll: rows.length > 20 }));
    wrap.appendChild(addButton('insuranceCodes', function () { return UR.defaultMappings.blankInsurance(''); }));
    return wrap;
  }

  function renderAdmissionSources() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'No default admission-source mappings were supplied by the hospital. Values found in the data are inventoried and stay Unknown until mapped here.' }));
    var att = attributedCounts('admissionSource', 'admissionSources');
    var notice = unmappedNotice(att, 'admissionSources', UR.defaultMappings.blankAdmissionSource);
    if (notice) { wrap.appendChild(notice); }

    var rows = ui.config.admissionSources.map(function (row, i) {
      return [
        editText(row, 'code', function () { markConfigChanged(); }),
        editText(row, 'label', function () { markConfigChanged(); }),
        editText(row, 'category', function () { markConfigChanged(); }),
        att.byCode[util.codeExact(row.code)] || 0,
        editCheckbox(row, 'enabled', function () { markConfigChanged(); }),
        removeButton('admissionSources', i)
      ];
    });
    wrap.appendChild(table(['Code', 'Display label', 'Category', 'Rows in data', 'Enabled', ''], rows, { numeric: ['Rows in data'] }));
    wrap.appendChild(addButton('admissionSources', function () { return UR.defaultMappings.blankAdmissionSource(''); }));
    return wrap;
  }

  function renderTransitionSettings() {
    var t = ui.config.transition;
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'These tolerances decide when two accounts are treated as one continuous episode. Timing alone never creates a link: a transition discharge code is always required.' }));
    wrap.appendChild(table(['Setting', 'Value', 'Effect'], [
      [ 'Maximum transition gap (minutes)', editNumber(t, 'maxGapMinutes', function () { markConfigChanged(); }),
        'Largest positive gap between a discharge and the successor admission that still links.' ],
      [ 'Negative overlap tolerance (minutes)', editNumber(t, 'overlapToleranceMinutes', function () { markConfigChanged(); }),
        'A successor starting this far before the prior discharge links as Probable with a warning.' ],
      [ 'Require the same calendar date', editCheckbox(t, 'requireSameCalendarDate', function () { markConfigChanged(); }),
        'When on, a successor on the next calendar date is never linked automatically.' ],
      [ 'Suspicious gap threshold (minutes)', editNumber(t, 'suspiciousGapMinutes', function () { markConfigChanged(); }),
        'Accepted links wider than this are flagged for verification.' ],
      [ 'Uncoded transition detection window (minutes)', editNumber(t, 'uncodedTransitionWindowMinutes', function () { markConfigChanged(); }),
        'Same-day service changes inside this window are reported as possible uncoded transitions. Never linked.' ]
    ]));
    return wrap;
  }

  function renderThresholds() {
    var th = ui.config.thresholds;
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'Thresholds are read by the calculation engine at run time and printed in the Calculation Reference, so a change here is visible in the exported workbook.' }));
    wrap.appendChild(table(['Threshold', 'Value', 'Rules affected'], [
      ['CAH acute target (hours)', editNumber(th, 'acuteTargetHours', function () { markConfigChanged(); }), ruleLinkList('IP_GT4_001, IP_GT4_PCT_001, IP_EXCESS_001, RQ_IP_GT4')],
      ['Operational target (days)', editNumber(th, 'acuteTargetDays', function () { markConfigChanged(); }), ruleLinkList('IP_TARGET_001')],
      ['Observation thresholds (hours)', editList(th, 'obsThresholdHours', function () { markConfigChanged(); }), ruleLinkList('OS_24_001, OS_36_001, OS_48_001, RQ_OS_*')],
      ['One-day stay ceiling (hours)', editNumber(th, 'oneDayStayHours', function () { markConfigChanged(); }), ruleLinkList('IP_SHORT_001, RQ_1DAY')],
      ['Short-stay midnight threshold', editNumber(th, 'shortStayMidnights', function () { markConfigChanged(); }), ruleLinkList('IP_2MN_001, RQ_SHORT_MCR')],
      ['MOON screening threshold (hours)', editNumber(th, 'moonThresholdHours', function () { markConfigChanged(); }), ruleLinkList('RQ_MOON')],
      ['Readmission windows (days)', editList(th, 'readmissionWindowDays', function () { markConfigChanged(); }), ruleLinkList('READMIT_7_001, READMIT_30_001, READMIT_MCR_001')]
    ]));
    return wrap;
  }

  function renderProcessing() {
    var p = ui.config.processing;
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'These options change which records qualify for a metric. Each one is recorded in the exported Run Metadata worksheet so two runs are never silently different.' }));
    wrap.appendChild(table(['Option', 'Value', 'Effect'], [
      [ 'Discharged-stay period basis',
        editSelect(p, 'losBasis', [
          { value: 'discharge', label: 'Discharge date (the stay counts in the period it ended)' },
          { value: 'admission', label: 'Admission date (the stay counts in the period it began)' }
        ], function () { markConfigChanged(); }),
        'Decides which discharged stays fall in the reporting period for LOS, ALOS, and threshold counts.' ],
      [ 'Include open encounters in occupancy',
        editCheckbox(p, 'includeOpenInOccupancy', function () { markConfigChanged(); }),
        'Open stays contribute occupancy through the as-of datetime. They are always excluded from discharged-stay ALOS.' ],
      [ 'Exclude patient names from the export',
        editCheckbox(p, 'excludePatientNames', function () { markConfigChanged(); }),
        'Removes the patient-name column from every exported detail and review sheet.' ],
      [ 'Collapse identical duplicate rows',
        editCheckbox(p, 'deduplicateIdenticalRows', function () { markConfigChanged(); }),
        'When off, identical rows are counted more than once and reported as a warning.' ]
    ]));
    return wrap;
  }

  /* ------------------------------------------------------- editor controls */

  function editText(row, key, onChange) {
    return el('input', {
      type: 'text', value: row[key] === null || row[key] === undefined ? '' : row[key],
      onchange: function (ev) { row[key] = ev.target.value; onChange(); }
    });
  }

  function editNumber(row, key, onChange) {
    return el('input', {
      type: 'number', value: row[key], step: 'any',
      onchange: function (ev) {
        var v = Number(ev.target.value);
        if (!isNaN(v) && v >= 0) { row[key] = v; onChange(); }
      }
    });
  }

  function editList(row, key, onChange) {
    return el('input', {
      type: 'text', value: (row[key] || []).join(', '),
      onchange: function (ev) {
        var parts = ev.target.value.split(',').map(function (s) { return Number(s.trim()); })
          .filter(function (n) { return !isNaN(n); });
        if (parts.length) { row[key] = parts; onChange(); }
      }
    });
  }

  function editSelect(row, key, options, onChange) {
    return el('select', {
      onchange: function (ev) { row[key] = ev.target.value === '' ? null : ev.target.value; onChange(); }
    }, options.map(function (o) {
      var selected = (row[key] === null || row[key] === undefined ? '' : row[key]) === o.value;
      return el('option', { value: o.value, selected: selected ? true : null }, [o.label]);
    }));
  }

  function editCheckbox(row, key, onChange) {
    return el('input', {
      type: 'checkbox', checked: row[key] ? true : null,
      onchange: function (ev) { row[key] = ev.target.checked; onChange(); }
    });
  }

  function removeButton(listKey, index) {
    return el('button', {
      type: 'button', class: 'link',
      onclick: function () { ui.config[listKey].splice(index, 1); markConfigChanged(); }
    }, ['Remove']);
  }

  function addButton(listKey, factory) {
    return el('button', {
      type: 'button',
      onclick: function () { ui.config[listKey].push(factory()); markConfigChanged(); }
    }, ['Add row']);
  }

  /* ------------------------------------------------------------- overview */

  function process() {
    var options = {};
    var startValue = $('period-start').value;
    var endValue = $('period-end').value;
    /*
     * The Overview back-fills the date inputs with the inferred period so they
     * are editable, so a filled input alone does not mean the user chose it.
     * Only a period the user actually touched outranks the inference -
     * otherwise every reprocess would relabel the same dates "chosen by user".
     */
    if (ui.periodTouched && startValue && endValue) {
      options.periodStart = parseDateInput(startValue);
      options.periodEnd = parseDateInput(endValue);
    }
    /*
     * Observation segments come from two places: typed entries, and OS -> IP
     * rows parsed out of imported CPSI Service Log PDFs. A typed entry for an
     * account outranks the report's row for the same account, so an operator
     * correction is never overwritten by a re-read of the PDF.
     */
    var manualEntries = ui.manualObservations.slice();
    var manualAccounts = {};
    manualEntries.forEach(function (m) { manualAccounts[m.account] = true; });
    ui.files.forEach(function (file) {
      if (!file.serviceLog) { return; }
      file.serviceLog.rows.forEach(function (row) {
        if (row.from !== 'OS' || row.to !== 'IP') { return; }
        if (manualAccounts[row.account] || !row.changeDT) { return; }
        manualAccounts[row.account] = true;
        manualEntries.push({
          account: row.account,
          osAdmitDT: null, /* the observation began when the account opened */
          osDischargeDT: row.changeDT,
          suffix: '-SRVCLOG',
          source: 'from the CPSI Service Log report ' + file.fileName
        });
      });
    });
    if (manualEntries.length) {
      options.manualObservations = manualEntries;
    }
    ui.state = UR.pipeline.process(ui.sources, ui.config, options);
    return ui.state;
  }

  function parseDateInput(value) {
    var parts = String(value).split('-');
    return util.mkDT(Number(parts[0]), Number(parts[1]), Number(parts[2]), 0, 0);
  }

  /*
   * Period presets. Passing null dates returns to the inference (the default);
   * real dates count as a user choice, exactly as if they had been typed.
   */
  function applyPeriodPreset(startDT, endDT) {
    if (startDT && endDT) {
      $('period-start').value = util.fmtISODate(startDT);
      $('period-end').value = util.fmtISODate(endDT);
      ui.periodTouched = true;
    } else {
      $('period-start').value = '';
      $('period-end').value = '';
      ui.periodTouched = false;
    }
    ui.state = null;
    renderOverview();
  }

  function renderPeriodPresets(state) {
    var host = $('period-presets');
    clear(host);
    if (!state || !state.period || !state.dataSpan) { return; }

    function sameDay(a, b) { return !!a && !!b && util.fmtISODate(a) === util.fmtISODate(b); }
    function chip(label, title, active, onclick) {
      return el('button', {
        type: 'button',
        class: 'period-preset' + (active ? ' active' : ''),
        title: title || null,
        onclick: onclick
      }, [label]);
    }

    var period = state.period;
    var chosen = state.periodSource === 'Chosen by user';
    var endIncl = new Date(period.endExclusiveDT.getTime() - 1);

    host.appendChild(chip('Inferred (default)',
      state.inferredPeriod ? state.inferredPeriod.label : '',
      !chosen,
      function () { applyPeriodPreset(null, null); }));

    var span = state.dataSpan;
    var spanEndIncl = new Date(span.endExclusiveDT.getTime() - 1);
    host.appendChild(chip('Full data span', span.label,
      chosen && sameDay(period.startDT, span.startDT) && sameDay(endIncl, spanEndIncl),
      function () { applyPeriodPreset(span.startDT, spanEndIncl); }));

    /*
     * One chip per calendar month the data touches. A span longer than 14
     * months keeps only the most recent 14 so the row stays a row.
     */
    var months = UR.scope.monthsIn(span);
    if (months.length > 14) { months = months.slice(months.length - 14); }
    if (months.length > 1) {
      months.forEach(function (m) {
        var whole = UR.scope.monthPeriod(m.period.startDT);
        var wholeEndIncl = new Date(whole.endExclusiveDT.getTime() - 1);
        host.appendChild(chip(m.label, whole.label,
          chosen && sameDay(period.startDT, whole.startDT) && sameDay(endIncl, wholeEndIncl),
          function () { applyPeriodPreset(whole.startDT, wholeEndIncl); }));
      });
    }
  }

  /*
   * Send the user where a digest item is fixed. Rules items pick their tab,
   * accounts items arrive with the right filter preset, and expand items open
   * a fold further down the Overview itself.
   */
  function runAttentionAction(action) {
    if (!action) { return; }
    if (action.expand) {
      var node = $(action.expand);
      if (node) {
        node.open = true;
        if (node.scrollIntoView) { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }
      return;
    }
    if (action.tab) { ui.activeRulesTab = action.tab; }
    if (action.view === 'accounts') {
      $('account-search').value = action.search || '';
      $('account-service').value = '';
      $('account-status').value = action.status || '';
    }
    if (action.view) { goTo(action.view); }
  }

  /* A collapsed card: full detail preserved, one click below the digest. */
  function fold(id, label, countText, buildBody, open) {
    var body = el('div', { class: 'fold-body' });
    buildBody(body);
    return el('details', { class: 'fold', id: id, open: open ? true : null }, [
      el('summary', null, [
        label,
        countText ? el('span', { class: 'fold-count', text: '  -  ' + countText }) : null
      ]),
      body
    ]);
  }

  /* True when every canonical field resolved without any human decision. */
  function mappingWasAutomatic() {
    if (!ui.sources.length) { return false; }
    var validation = UR.headerMapper.validateMapping(ui.sources[0].mapping, ui.acknowledged);
    if (!validation.ok || (ui.autoResult && ui.autoResult.ambiguities.length)) { return false; }
    var manual = false;
    UR.headerMapper.FIELDS.forEach(function (f) {
      var m = ui.sources[0].mapping[f.key];
      if (m && m.basis === 'Chosen by user') { manual = true; }
    });
    return !manual;
  }

  function renderOverview() {
    if (!ui.state) { process(); }
    var state = ui.state;

    /* ------------------------------------------------------- status line */
    var status = $('overview-status');
    clear(status);
    var names = ui.sources.map(function (s) { return s.fileName; }).join(', ');
    /* A blocked run stops before the row census is taken. */
    var rowTotal = state.counts ? state.counts.imported
      : ui.sources.reduce(function (n, s) { return n + s.rows.length; }, 0);
    status.appendChild(el('p', { class: 'overview-status-line', text:
      'Processed ' + rowTotal + ' row(s) from ' + names +
      (mappingWasAutomatic()
        ? ' - every column was recognized automatically.'
        : ' - using the assignments on the Field Mapping screen.') }));

    /* -------------------------------------------------- attention digest */
    var attn = $('overview-attention');
    clear(attn);
    var items = UR.attention.build(state);
    if (!UR.attention.hasProblems(items)) {
      attn.appendChild(el('p', { class: 'attn-ok', text:
        'No data problems: every code was recognized and nothing was excluded by a data issue.' }));
    }
    if (items.length) {
      var list = el('div', { class: 'attn-list' });
      items.forEach(function (it) {
        list.appendChild(el('div', { class: 'attn-item' }, [
          pill(it.severity, it.severity.toLowerCase()),
          el('span', { class: 'attn-msg', text: it.message }),
          it.action ? el('button', {
            type: 'button', class: 'link',
            onclick: function () { runAttentionAction(it.action); }
          }, [it.action.expand ? 'Show' : 'Open']) : null
        ]));
      });
      attn.appendChild(list);
    }

    /* ------------------------------------------------------ summary grid */
    var summary = $('validate-summary');
    clear(summary);

    if (state.blocked) {
      summary.appendChild(el('div', { class: 'msg msg-blocking' }, [
        el('strong', { text: 'Processing stopped' }),
        doc.createTextNode('Fix the blocking item(s) above - each one links to the screen where it is resolved - and the run picks up from there.')
      ]));
    } else {
      var counts = state.counts;
      summary.appendChild(el('div', { class: 'summary-grid' }, [
        card('Rows imported', counts.imported, '', 'Across ' + ui.sources.length + ' worksheet(s)'),
        card('Included', counts.ip + ' IP / ' + counts.os + ' OS / ' + counts.sb + ' SB', '', ''),
        card('Excluded by service policy', counts.excludedByPolicy, '', counts.ignored + ' ignored, ' + counts.unknown + ' unrecognized'),
        card('Continuous episodes', state.episodes.length, 'EPISODE_001', ''),
        card('Transitions', (state.transitionCounts.osip + state.transitionCounts.ipsb + state.transitionCounts.sbip + state.transitionCounts.ossb),
          'TRANS_001', state.transitionCounts.osip + ' OS->IP, ' + state.transitionCounts.ipsb + ' IP->SB, ' + state.transitionCounts.sbip + ' SB->IP'),
        card('Open encounters', counts.open, 'DQ_OPEN', '')
      ]));
      summary.appendChild(el('p', { class: 'hint', text: state.summaryLines.join('  |  ') }));
    }

    /* ---------------------------------------------------- period fold */
    var periodSummary = $('ov-period').querySelector('summary');
    if (state.period) {
      if (!$('period-start').value) { $('period-start').value = util.fmtISODate(state.period.startDT); }
      if (!$('period-end').value) { $('period-end').value = util.fmtISODate(new Date(state.period.endExclusiveDT.getTime() - 1)); }
      periodSummary.textContent = 'Reporting period - ' + state.period.label + ' (' + state.periodSource.toLowerCase() + ')';
      var hint = state.periodSource + ': ' + state.period.label +
        ' | occupancy as of ' + util.fmtDateTime(state.period.asOf);
      /*
       * Only mention the data span when records actually fall outside the
       * period. A span that sits inside it is not a discrepancy worth flagging.
       */
      var span = state.dataSpan;
      if (span && (span.startDT.getTime() < state.period.startDT.getTime() ||
                   span.endExclusiveDT.getTime() > state.period.endExclusiveDT.getTime())) {
        hint += ' | imported records span ' + span.label +
          ' (stays that reach into the period still count in period figures; only records with no overlap are kept purely as context)';
      }
      $('period-hint').textContent = hint;
    } else {
      periodSummary.textContent = 'Reporting period';
      if (state.inferredPeriod) {
        $('period-hint').textContent = 'Detected range ' + state.inferredPeriod.label;
      }
    }
    renderPeriodPresets(state);

    /* ------------------------------------- diagnostics / inventory / trans */
    var host = $('validate-diagnostics');
    clear(host);
    var byRule = state.diagnostics.byRule(6);
    var dqCounts = state.diagnostics.counts();
    var dqParts = [];
    UR.SEVERITY_ORDER.forEach(function (sev) {
      if (dqCounts[sev]) { dqParts.push(dqCounts[sev] + ' ' + sev.toLowerCase()); }
    });

    host.appendChild(fold('ov-diagnostics', 'Diagnostics',
      byRule.length ? dqParts.join(', ') : 'none raised', function (body) {
      if (!byRule.length) {
        body.appendChild(el('p', { class: 'msg msg-info', text: 'No diagnostic was raised for this run.' }));
        return;
      }
      UR.SEVERITY_ORDER.forEach(function (severity) {
        var group = byRule.filter(function (g) { return g.severity === severity; });
        if (!group.length) { return; }
        body.appendChild(el('h3', null, [
          pill(severity, severity.toLowerCase()),
          doc.createTextNode(' ' + group.length + ' rule(s)')
        ]));
        body.appendChild(table(['Rule ID', 'Finding', 'Count', 'Sample accounts', 'Effect', ''],
          group.map(function (g) {
            var rule = UR.dataQualityRules.byId(g.ruleId);
            return [
              ruleLink(g.ruleId), g.name, g.count, accountLinkList(g.samples), rule ? rule.effect : '',
              el('button', {
                type: 'button', class: 'link',
                onclick: function () { showDiagnosticDetail(g.ruleId); }
              }, ['Show rows'])
            ];
          }), { numeric: ['Count'] }));
      });
    }, state.blocked));

    var invSections = state.codeInventory || [];
    var distinct = 0, unrecognized = 0;
    invSections.forEach(function (s) {
      s.rows.forEach(function (r) {
        distinct++;
        if (r.status === UR.codeInventory.STATUS.UNRECOGNIZED) { unrecognized++; }
      });
    });
    host.appendChild(fold('ov-inventory', 'Code inventory',
      !invSections.length ? 'not reached'
        : distinct + ' distinct value(s)' + (unrecognized ? ', ' + unrecognized + ' unrecognized' : ', all recognized'),
      function (body) {
      if (!invSections.length) {
        body.appendChild(el('p', { class: 'hint', text: 'No code inventory: processing did not reach the code-scanning stage.' }));
        return;
      }
      body.appendChild(el('p', { class: 'hint', text: 'Every distinct code encountered, with the behavior applied. Resolve anything marked Unrecognized before treating a run as final.' }));
      invSections.forEach(function (section) {
        body.appendChild(el('h3', { text: section.type + (section.mapped ? '' : ' (column not mapped)') }));
        body.appendChild(table(['Value', 'Count', 'Configured meaning', 'Behavior', 'Status', 'Sample accounts'],
          section.rows.map(function (r) {
            return [r.value, r.count, r.mappedTo || '', r.behavior,
              r.status === UR.codeInventory.STATUS.UNRECOGNIZED ? pill(r.status, 'warning') : r.status,
              accountLinkList(r.samples)];
          }), { numeric: ['Count'], scroll: section.rows.length > 12 }));
      });
    }));

    var transitions = state.transitions || [];
    var accepted = 0;
    transitions.forEach(function (t) {
      if (t.confidence === UR.LINK_CONFIDENCE.CONFIRMED || t.confidence === UR.LINK_CONFIDENCE.PROBABLE) { accepted++; }
    });
    host.appendChild(fold('ov-transitions', 'Transitions',
      transitions.length ? transitions.length + ' attempted, ' + accepted + ' accepted' : 'none attempted',
      function (body) {
      if (!transitions.length) {
        body.appendChild(el('p', { class: 'hint', text: 'No account carried a transition discharge code, and no unexplained same-day service change was detected.' }));
        return;
      }
      body.appendChild(el('p', { class: 'hint', text: 'Every attempted internal status change, accepted or refused. Open an account in the Accounts view to see one patient at a time.' }));
      body.appendChild(table(['Prior account', 'Next account', 'Services', 'Discharge code', 'Gap (min)', 'Confidence', 'Episode', 'Issue'],
        transitions.map(function (t) {
          var from = null;
          state.encounters.forEach(function (e) { if (e.rowId === t.fromRowId) { from = e; } });
          return [accountLink(t.fromAccount), t.toAccount ? accountLink(t.toAccount) : accountLinkList(t.candidateAccounts || []),
            t.fromService + ' -> ' + (t.toService || t.expectedService || '?'), t.dischargeCode,
            t.gapMinutes === null ? '' : util.round(t.gapMinutes, 0),
            t.confidence === UR.LINK_CONFIDENCE.CONFIRMED ? t.confidence : pill(t.confidence, t.confidence === UR.LINK_CONFIDENCE.PROBABLE ? 'info' : 'warning'),
            from ? (from.episodeId || '') : '', t.issue];
        }), { scroll: transitions.length > 12 }));
    }));

    $('btn-to-results').disabled = !!state.blocked;
    $('btn-overview-review').disabled = !!state.blocked;
    $('btn-overview-export').disabled = !!state.blocked;
    renderNav('overview');
  }

  function showDiagnosticDetail(ruleId) {
    var items = ui.state.diagnostics.all().filter(function (d) { return d.ruleId === ruleId; });
    var rule = UR.dataQualityRules.byId(ruleId);
    var body = el('div');
    if (rule) {
      body.appendChild(el('p', null, [el('strong', { text: rule.description }), doc.createTextNode(' ' + rule.effect)]));
    }
    body.appendChild(table(['Account', 'Patient ID', 'Service', 'Message', 'Source file', 'Row'],
      items.map(function (d) { return [accountLink(d.account), d.mrn, d.service, d.message, d.sourceFile, d.sourceRow]; }),
      { scroll: true }));
    openModal(ruleId + ' - ' + (rule ? rule.name : ''), body);
  }

  /* ----------------------------------------------------------- 5. results */

  function card(label, value, ruleId, note, onDetail) {
    var node = el('div', { class: 'metric-card' }, [
      el('span', { class: 'metric-label', text: label }),
      el('span', { class: 'metric-value', text: value === null || value === undefined ? '-' : String(value) })
    ]);
    if (ruleId) { node.appendChild(ruleLink(ruleId, 'metric-rule')); }
    if (note) { node.appendChild(el('span', { class: 'metric-note', text: note })); }
    if (onDetail) {
      node.appendChild(el('button', { type: 'button', class: 'link', onclick: onDetail }, ['Show underlying rows']));
    }
    return node;
  }

  function showRows(title, encounters) {
    var body = el('div');
    body.appendChild(el('p', { class: 'hint', text: encounters.length + ' account(s). This view is on screen only; nothing is saved.' }));
    body.appendChild(table(
      ['Account', 'Patient ID', 'Patient name', 'Service', 'Admit', 'Discharge', 'LOS hours', 'Midnights', 'Payer', 'Discharge code', 'Episode'],
      encounters.map(function (e) {
        return [accountLink(e.account), e.mrn, e.name, e.serviceClass, util.fmtDateTime(e.admitDT),
          e.isOpen ? '(open)' : util.fmtDateTime(e.dischargeDT), num(e.durationHours, 1),
          e.midnights, e.payerCategory, e.dischargeCodeRaw, e.episodeId || ''];
      }), { scroll: true }));
    openModal(title, body);
  }

  /*
   * Metric rows read better than a wall of equally-weighted cards: the eye can
   * run down a value column, the comparison sits beside the number instead of
   * under it, and every row carries the Rule ID that produced it.
   *
   * headline() is reserved for the handful of figures a UR reviewer opens the
   * page to see; everything else is a row in a titled section.
   */
  function metricRow(label, value, unit, detail, ruleId, onDetail, tone) {
    return {
      label: label, value: value, unit: unit || '',
      detail: detail || '', ruleId: ruleId || '', onDetail: onDetail || null, tone: tone || ''
    };
  }

  function renderMetricSection(host, title, note, rows) {
    host.appendChild(el('h3', { text: title }));
    if (note) { host.appendChild(el('p', { class: 'hint', text: note })); }

    var body = el('tbody', null, rows.map(function (r) {
      var valueCell = el('td', { class: 'metric-value-cell' }, [
        el('span', { class: 'metric-number' + (r.tone ? ' tone-' + r.tone : ''), text: r.value }),
        r.unit ? el('span', { class: 'metric-unit', text: ' ' + r.unit }) : null
      ]);
      return el('tr', null, [
        el('th', { class: 'metric-label-cell', scope: 'row', text: r.label }),
        valueCell,
        el('td', { class: 'metric-detail-cell', text: r.detail }),
        el('td', { class: 'metric-rule-cell' }, [
          r.ruleId ? ruleLinkList(r.ruleId) : null,
          r.onDetail ? el('button', { type: 'button', class: 'link', onclick: r.onDetail }, ['rows']) : null
        ])
      ]);
    }));

    host.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'metric-table' }, [
        el('thead', null, [el('tr', null, [
          el('th', { text: 'Metric' }), el('th', { text: 'Value' }),
          el('th', { text: 'Detail' }), el('th', { text: 'Rule' })
        ])]),
        body
      ])
    ]));
  }

  function renderResults() {
    if (!ui.state) { process(); }
    var state = ui.state;
    var host = $('results-body');
    clear(host);
    if (state.blocked) {
      host.appendChild(el('div', { class: 'msg msg-blocking', text: 'Processing was blocked. Open the Overview to see why.' }));
      return;
    }

    var m = state.metrics;
    var th = ui.config.thresholds;
    var dq = state.diagnostics.counts();
    var readmits = UR.pipeline.readmissionsInPeriod(state, state.period);

    /* ------------------------------------------------------------ headline */
    host.appendChild(el('p', { class: 'period-line' }, [
      el('strong', { text: state.period.label }),
      doc.createTextNode('  |  ' + state.periodSource.toLowerCase() +
        '  |  discharged stays counted by ' + ui.config.processing.losBasis + ' date' +
        '  |  occupancy as of ' + util.fmtDateTime(state.period.asOf))
    ]));

    var cahTone = m.inpatient.IP_TARGET_001.withinTarget === null ? ''
      : (m.inpatient.IP_TARGET_001.withinTarget ? 'good' : 'warn');

    host.appendChild(el('div', { class: 'headline-grid' }, [
      headline('Continuous episodes', m.census.EPISODE_CNT_001.value, '', 'EPISODE_CNT_001', 'Hospital episodes, internal transitions collapsed'),
      headline('Acute mean LOS', num(m.inpatient.IP_ALOS_001.days, 2), 'days', 'IP_ALOS_001', num(m.inpatient.IP_ALOS_001.hours, 1) + ' hours over ' + m.inpatient.IP_ALOS_001.n + ' discharges'),
      headline(th.acuteTargetDays + '-day target variance', (m.inpatient.IP_TARGET_001.varianceDays === null ? '-' : (m.inpatient.IP_TARGET_001.varianceDays > 0 ? '+' : '') + num(m.inpatient.IP_TARGET_001.varianceDays, 2)), 'days', 'IP_TARGET_001', 'Against the CAH ' + th.acuteTargetDays + '-day (' + (th.acuteTargetDays * 24) + '-hour) annual expectation', cahTone),
      headline('Observation > ' + th.obsThresholdHours[0] + 'h', withPct(m.observation.OS_24_001.value, m.observation.OS_24_PCT_001.value), '', 'OS_24_001', 'of ' + m.observation.OS_ALOS_001.n + ' discharged observation stays'),
      headline('Accounts to review', state.reviewQueue.byAccount.length, '', '', state.reviewQueue.rows.length + ' reasons across the queue'),
      headline('Data issues', dq.Blocking + dq.Error, '', '', dq.Warning + ' warnings, ' + dq.Info + ' notices', (dq.Blocking + dq.Error) ? 'warn' : 'good')
    ]));

    /* ----------------------------------------------------------- inpatient */
    renderMetricSection(host, 'Acute inpatient', '', [
      metricRow('Admissions (service accounts)', m.inpatient.IP_ADM_001.value, '', 'Includes accounts created by a status change', 'IP_ADM_001',
        function () { showRows('IP_ADM_001 - acute inpatient admissions', m.inpatient.IP_ADM_001.encounters); }),
      metricRow('Discharged accounts in scope', m.inpatient.IP_ALOS_001.n, '', 'By ' + ui.config.processing.losBasis + ' date within the period', 'IP_LOS_001',
        function () { showRows('IP_LOS_001 - qualifying discharged IP accounts', m.inpatient.IP_LOS_001.encounters); }),
      metricRow('Mean length of stay', num(m.inpatient.IP_ALOS_001.hours, 1), 'hours', num(m.inpatient.IP_ALOS_001.days, 2) + ' days', 'IP_ALOS_001'),
      metricRow('Median length of stay', num(m.inpatient.IP_MEDLOS_001.hours, 1), 'hours', num(m.inpatient.IP_MEDLOS_001.days, 2) + ' days', 'IP_MEDLOS_001'),
      metricRow(th.acuteTargetDays + '-day target variance', num(m.inpatient.IP_TARGET_001.varianceDays, 2), 'days',
        num(m.inpatient.IP_TARGET_001.varianceHours, 1) + ' hours. Surveillance estimate; the CAH requirement is an annual average', 'IP_TARGET_001', null, cahTone),
      metricRow('Stays over ' + th.acuteTargetHours + 'h', withPct(m.inpatient.IP_GT4_001.value, m.inpatient.IP_GT4_PCT_001.value), '',
        'Of ' + m.inpatient.IP_GT4_PCT_001.denominator + ' discharged accounts', 'IP_GT4_001, IP_GT4_PCT_001',
        function () { showRows('IP_GT4_001 - stays over target', m.inpatient.IP_GT4_001.detail.map(function (d) { return d.encounter; })); }),
      metricRow('Excess days above target', num(m.inpatient.IP_EXCESS_001.totalDays, 2), 'days',
        'Mean ' + num(m.inpatient.IP_EXCESS_001.meanDaysAmongLongStays, 2) + ' days among the long stays', 'IP_EXCESS_001'),
      metricRow('One-day stays', withPct(m.inpatient.IP_SHORT_001.value, m.inpatient.IP_1DAY_PCT_001.value), '',
        'Of ' + m.inpatient.IP_1DAY_PCT_001.denominator + ' discharged accounts. ' + payerBreakdown(m.inpatient.IP_SHORT_001.byPayer), 'IP_SHORT_001, IP_1DAY_PCT_001',
        function () { showRows('IP_SHORT_001 - one-day acute stays', m.inpatient.IP_SHORT_001.encounters); }),
      metricRow('Medicare/MA under ' + th.shortStayMidnights + ' midnights', withPct(m.inpatient.IP_2MN_001.value, m.inpatient.IP_2MN_PCT_001.value), '',
        'Of ' + m.inpatient.IP_2MN_PCT_001.denominator + ' Medicare/MA discharged accounts. Review candidates only; no appropriateness conclusion', 'IP_2MN_001, IP_2MN_PCT_001',
        function () { showRows('IP_2MN_001 - short Medicare inpatient stays', m.inpatient.IP_2MN_001.encounters); })
    ]);

    /* --------------------------------------------------------- observation */
    renderMetricSection(host, 'Observation', '', [
      metricRow('Admissions', m.observation.OS_ADM_001.value, '', '', 'OS_ADM_001',
        function () { showRows('OS_ADM_001 - observation admissions', m.observation.OS_ADM_001.encounters); }),
      metricRow('Mean duration', num(m.observation.OS_ALOS_001.meanHours, 1), 'hours', 'Median ' + num(m.observation.OS_ALOS_001.medianHours, 1) + ' hours', 'OS_ALOS_001'),
      metricRow('Over ' + th.obsThresholdHours[0] + ' hours', withPct(m.observation.OS_24_001.value, m.observation.OS_24_PCT_001.value), '',
        'Of ' + m.observation.OS_24_PCT_001.denominator + ' discharged observation stays', 'OS_24_001, OS_24_PCT_001',
        function () { showRows('OS_24_001', m.observation.OS_24_001.encounters); }),
      metricRow('Over ' + th.obsThresholdHours[1] + ' hours', withPct(m.observation.OS_36_001.value, m.observation.OS_36_001.percent), '', '', 'OS_36_001',
        function () { showRows('OS_36_001', m.observation.OS_36_001.encounters); }),
      metricRow('Over ' + th.obsThresholdHours[2] + ' hours', withPct(m.observation.OS_48_001.value, m.observation.OS_48_001.percent), '',
        'High-priority prolonged observation', 'OS_48_001',
        function () { showRows('OS_48_001', m.observation.OS_48_001.encounters); }),
      metricRow('Conversions to inpatient', withPct(m.observation.OSIP_001.value, m.observation.OSIP_RATE_001.value), '',
        'Accepted internal OS to IP transitions. ' + m.observation.OSIP_RATE_001.denominatorNote, 'OSIP_001, OSIP_RATE_001'),
      metricRow('Hours before conversion', num(m.observation.OSIP_TIME_001.meanHours, 1), 'hours mean', 'Median ' + num(m.observation.OSIP_TIME_001.medianHours, 1) + ' hours', 'OSIP_TIME_001')
    ]);

    /* ----------------------------------------------------------- swing bed */
    renderMetricSection(host, 'Swing bed', 'Kept separate from acute inpatient throughout: swing-bed days are excluded from the CAH average.', [
      metricRow('Admissions', m.swingBed.SB_ADM_001.value, '', '', 'SB_ADM_001',
        function () { showRows('SB_ADM_001 - swing-bed admissions', m.swingBed.SB_ADM_001.encounters); }),
      metricRow('Mean length of stay', num(m.swingBed.SB_ALOS_001.meanDays, 2), 'days', 'Median ' + num(m.swingBed.SB_ALOS_001.medianDays, 2) + ' days', 'SB_ALOS_001'),
      metricRow('IP to SB transitions', m.swingBed.IPSB_001.value, '', '', 'IPSB_001'),
      metricRow('SB to IP transitions', m.swingBed.SBIP_001.value, '', 'Hospital-specific use of discharge code V', 'SBIP_001'),
      metricRow('OS to SB transitions', m.swingBed.OSSB_001.value, '', '', 'OSSB_001')
    ]);

    /* ------------------------------------------------- volume and census */
    renderMetricSection(host, 'Volume, patient days, and census',
      'Two patient-day methods are reported on purpose. Compare both against the existing UR workbook before naming either one the official hospital measure.', [
      metricRow('Service admissions', m.census.ADM_SVC_001.value, '',
        m.census.ADM_SVC_001.ip + ' IP, ' + m.census.ADM_SVC_001.os + ' OS, ' + m.census.ADM_SVC_001.sb + ' SB - includes status changes', 'ADM_SVC_001'),
      metricRow('Continuous episodes', m.census.EPISODE_CNT_001.value, '', 'Recommended headline count', 'EPISODE_CNT_001'),
      metricRow('Unique patients', m.census.PATIENT_CNT_001.value, '', 'Distinct derived patient IDs (name + age)', 'PATIENT_CNT_001'),
      metricRow('Equivalent patient days', num(m.census.PD_EQ_001.value, 2), 'days', 'Time-weighted method', 'PD_EQ_001'),
      metricRow('Midnight census patient days', m.census.PD_MN_001.value, 'days', 'Midnight census method', 'PD_MN_001'),
      metricRow('Inpatient patient days', m.census.PD_IP_001.midnightDays, 'days',
        'Midnight census; ' + num(m.census.PD_IP_001.equivalentDays, 2) + ' time-weighted', 'PD_IP_001'),
      metricRow('Observation patient days', m.census.PD_OS_001.midnightDays, 'days',
        'Midnight census; ' + num(m.census.PD_OS_001.equivalentDays, 2) + ' time-weighted', 'PD_OS_001'),
      metricRow('Swing-bed patient days', m.census.PD_SB_001.midnightDays, 'days',
        'Midnight census; ' + num(m.census.PD_SB_001.equivalentDays, 2) + ' time-weighted', 'PD_SB_001'),
      metricRow('Time-weighted ADC', num(m.census.ADC_EQ_001.value, 2), '', 'Over ' + state.period.days + ' calendar days', 'ADC_EQ_001'),
      metricRow('Midnight ADC', num(m.census.ADC_MN_001.value, 2), '', 'Over ' + state.period.days + ' calendar days', 'ADC_MN_001'),
      metricRow('Deaths', withPct(m.payer.DEATH_001.value, m.payer.DEATH_001.percent), '', 'Of discharges in the period', 'DEATH_001',
        function () { showRows('DEATH_001 - deaths', m.payer.DEATH_001.encounters); })
    ]);

    /* --------------------------------------------------------- readmission */
    renderMetricSection(host, 'Readmission indicators',
      'Internal operational indicators. Not CMS risk-standardized measures, and internal status transitions can never appear here.', [
      metricRow('Within ' + th.readmissionWindowDays[0] + ' days', readmits.short, '', 'New acute IP episode after a prior episode final discharge', 'READMIT_7_001'),
      metricRow('Within ' + th.readmissionWindowDays[1] + ' days', readmits.long, '', '', 'READMIT_30_001'),
      metricRow('Medicare within ' + th.readmissionWindowDays[1] + ' days', readmits.medicare, '', 'Payer taken from the readmitting account', 'READMIT_MCR_001')
    ]);

    renderNav('results');
  }

  function headline(label, value, unit, ruleId, note, tone) {
    return el('div', { class: 'headline-card' }, [
      el('span', { class: 'headline-label', text: label }),
      el('span', { class: 'headline-value' + (tone ? ' tone-' + tone : '') }, [
        doc.createTextNode(value === null || value === undefined ? '-' : String(value)),
        unit ? el('span', { class: 'headline-unit', text: ' ' + unit }) : null
      ]),
      note ? el('span', { class: 'headline-note', text: note }) : null,
      ruleId ? ruleLink(ruleId, 'headline-rule') : null
    ]);
  }

  function payerBreakdown(byPayer) {
    var parts = [];
    Object.keys(byPayer).forEach(function (k) { parts.push(k + ': ' + byPayer[k]); });
    return parts.join(', ');
  }

  /* -------------------------------------------------------- review queue */

  /* Jump to one account's full course in the Accounts view. */
  function openAccount(account) {
    ui.selectedAccount = account;
    $('account-search').value = String(account);
    $('account-service').value = '';
    $('account-status').value = '';
    goTo('accounts');
  }

  function renderReview() {
    if (!ui.state) { process(); }
    var state = ui.state;
    var host = $('review-body');
    clear(host);

    if (state.blocked) {
      $('review-count').textContent = '';
      host.appendChild(el('div', { class: 'msg msg-blocking', text: 'Processing was blocked, so no review queue could be built. Open the Overview to see why.' }));
      renderNav('review');
      return;
    }

    /* Reason filter offers only the rules that produced rows this run. */
    var select = $('review-rule');
    var current = ui.reviewRuleFilter || '';
    if (current && !(state.reviewQueue.counts[current] > 0)) { current = ''; ui.reviewRuleFilter = ''; }
    clear(select);
    select.appendChild(el('option', { value: '' }, ['All reasons']));
    UR.reviewRules.ids().forEach(function (id) {
      var count = state.reviewQueue.counts[id] || 0;
      if (!count) { return; }
      var rule = UR.reviewRules.byId(id);
      select.appendChild(el('option', { value: id, selected: current === id ? true : null },
        [rule.name + ' (' + count + ')']));
    });
    select.value = current;

    var query = String($('review-search').value || '').toLowerCase();
    var showNames = !ui.config.processing.excludePatientNames;

    var all = state.reviewQueue.byAccount;
    var rows = all.filter(function (r) {
      if (current && r.ruleIds.split(', ').indexOf(current) < 0) { return false; }
      if (query) {
        var hay = (r.account + ' ' + (r.mrn || '') + ' ' + (r.patientName || '')).toLowerCase();
        if (hay.indexOf(query) < 0) { return false; }
      }
      return true;
    });

    $('review-count').textContent = rows.length + ' of ' + all.length + ' account(s), ' +
      state.reviewQueue.rows.length + ' reason(s) across the queue';

    if (!all.length) {
      host.appendChild(el('p', { class: 'attn-ok', text: 'The review queue is empty: no account met any objective trigger in this run.' }));
      renderNav('review');
      return;
    }
    if (!rows.length) {
      host.appendChild(el('p', { class: 'hint', text: 'No account matches the current filter.' }));
      renderNav('review');
      return;
    }

    var thead = el('thead', null, [el('tr', null,
      ['Account', showNames ? 'Patient' : 'Patient ID', 'Service', 'Payer', 'Admit', 'Discharge', 'Review for']
        .map(function (h) { return el('th', { text: h }); }))]);

    var tbody = el('tbody', null, rows.map(function (r) {
      /* r.reasons is "Rule name: detail | Rule name: detail". */
      var reasons = r.reasons.split(' | ').map(function (line) {
        var cut = line.indexOf(': ');
        return el('div', { class: 'review-reason' }, cut > 0
          ? [el('strong', { text: line.slice(0, cut) }), doc.createTextNode(' - ' + line.slice(cut + 2))]
          : [line]);
      });
      return el('tr', {
        title: 'Open account ' + r.account + ' in the Accounts view',
        onclick: function () { openAccount(r.account); }
      }, [
        el('td', null, [el('strong', { text: r.account })]),
        el('td', { text: showNames ? (r.patientName || ('Patient ' + (r.mrn || '(no ID)'))) : (r.mrn || '(none)') }),
        el('td', { text: r.service }),
        el('td', { text: r.payerCategory }),
        el('td', { text: util.fmtDateTime(r.admit) }),
        el('td', { text: r.discharge ? util.fmtDateTime(r.discharge) : '(open)' }),
        el('td', null, reasons)
      ]);
    }));

    host.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'review-table' }, [thead, tbody])
    ]));
    renderNav('review');
  }

  /* ----------------------------------------------------------- accounts */

  function renderAccounts() {
    if (!ui.state) { process(); }
    var listHost = $('account-list');
    var detailHost = $('account-detail');
    clear(listHost);

    if (ui.state.blocked) {
      clear(detailHost);
      listHost.appendChild(el('div', { class: 'msg msg-blocking', text: 'Processing was blocked, so no account list could be built. Open the Overview to see why.' }));
      return;
    }

    var all = UR.accountDetail.list(ui.state);
    var rows = UR.accountDetail.search(all, $('account-search').value, {
      service: $('account-service').value,
      status: $('account-status').value
    });

    $('account-count').textContent = rows.length + ' of ' + all.length + ' account(s)';

    if (!rows.length) {
      listHost.appendChild(el('p', { class: 'hint', text: 'No account matches the current filter.' }));
    }

    rows.forEach(function (row) {
      var badges = el('span', { class: 'account-badges' });
      if (row.status === 'Excluded') { badges.appendChild(pill('Excluded', 'warning')); }
      if (row.isOpen) { badges.appendChild(pill('Open', 'info')); }
      if (!row.inPeriod) { badges.appendChild(pill('Outside period', 'info')); }
      if (row.partialPeriod) { badges.appendChild(pill('Crosses period start', 'info')); }
      if (row.manualEntry) { badges.appendChild(pill('Manual entry', 'warning')); }
      if (row.manualObsAdjusted) { badges.appendChild(pill('Admit moved after manual OBS', 'info')); }
      if (row.reviewRuleIds.length) { badges.appendChild(pill(row.reviewRuleIds.length + ' review', 'operational')); }
      if (row.worstSeverity === UR.SEVERITY.ERROR || row.worstSeverity === UR.SEVERITY.BLOCKING) {
        badges.appendChild(pill(row.worstSeverity, row.worstSeverity.toLowerCase()));
      }

      var item = el('button', {
        type: 'button',
        class: 'account-item' + (ui.selectedAccount === row.account ? ' selected' : ''),
        onclick: function () {
          ui.selectedAccount = row.account;
          renderAccounts();
        }
      }, [
        el('span', { class: 'account-item-head' }, [
          el('strong', { text: row.account }),
          el('span', { class: 'account-service', text: row.serviceRaw + (row.serviceClass !== row.serviceRaw ? ' -> ' + row.serviceClass : '') })
        ]),
        el('span', { class: 'account-item-sub', text:
          (ui.config.processing.excludePatientNames ? 'Patient ' + (row.mrn || '(no ID)') : (row.patientName || '(no name)') + '  |  ' + (row.mrn || '(no patient ID)')) }),
        el('span', { class: 'account-item-sub', text:
          util.fmtDateTime(row.admitDT) + (row.isOpen ? '  ->  (open)' : '  ->  ' + util.fmtDateTime(row.dischargeDT)) +
          (row.durationHours === null ? '' : '  |  ' + util.round(row.durationHours, 1) + 'h') }),
        badges
      ]);
      listHost.appendChild(item);
    });

    renderAccountDetail(detailHost);
  }

  function renderAccountDetail(host) {
    clear(host);
    if (!ui.selectedAccount) {
      host.appendChild(el('p', { class: 'hint', text: 'Select an account on the left to see the full patient course.' }));
      return;
    }
    var dossier = UR.accountDetail.forAccount(ui.state, ui.selectedAccount);
    if (!dossier) {
      host.appendChild(el('p', { class: 'hint', text: 'That account is no longer in the current run.' }));
      return;
    }
    var showNames = !ui.config.processing.excludePatientNames;

    host.appendChild(el('h3', { text: showNames && dossier.patientName ? dossier.patientName : ('Patient ' + (dossier.mrn || '(no ID)')) }));
    host.appendChild(el('p', { class: 'hint', text:
      'Patient ID ' + (dossier.mrn || '(none)') + '  |  ' + dossier.totals.visits + ' visit(s), ' +
      dossier.totals.included + ' counted in metrics  |  ' + dossier.totals.episodes + ' continuous episode(s)  |  ' +
      dossier.totals.acceptedTransitions + ' accepted status transition(s)' +
      (dossier.hasMrn ? '' : '  |  No Patient ID could be derived (name or age unusable), so this record cannot be linked to any other account.') }));

    if (!dossier.hasMrn) {
      host.appendChild(el('div', { class: 'msg msg-warning', text:
        'Without a Patient ID - derived from the patient name and age, one of which is missing or unusable here - this account cannot take part in transition linkage or readmission logic, and it forms an episode of one.' }));
    }

    /* -------------------------------------------------------- episodes */
    if (dossier.episodes.length) {
      host.appendChild(el('h4', { text: 'Continuous episodes' }));
      host.appendChild(table(
        ['Episode', 'Service sequence', 'Accounts', 'First admit', 'Final discharge', 'Total elapsed', 'Final disposition'],
        dossier.episodes.map(function (ep) {
          return [ep.episodeId, ep.serviceSequence.join(' -> '), accountLinkList(ep.accounts),
            util.fmtDateTime(ep.startDT), ep.isOpen ? '(open)' : util.fmtDateTime(ep.endDT),
            ep.elapsedHours === null ? '-' : util.round(ep.elapsedHours, 1) + 'h (' + util.round(ep.elapsedDays, 2) + 'd)',
            ep.finalDisposition || '-'];
        })));
    }

    /* ------------------------------------------------------- transitions */
    host.appendChild(el('h4', { text: 'Status transitions' }));
    if (!dossier.transitions.length) {
      host.appendChild(el('p', { class: 'hint', text: 'No transition was attempted for this patient: no account carried a transition discharge code.' }));
    } else {
      host.appendChild(el('p', { class: 'hint', text: 'Refused links are listed too, with the reason. A refusal is why two accounts that look continuous in the chart are separate episodes here.' }));
      host.appendChild(table(
        ['From', 'To', 'Services', 'Discharge code', 'Gap', 'Same date', 'Result', 'Reason'],
        dossier.transitions.map(function (t) {
          var accepted = t.confidence === UR.LINK_CONFIDENCE.CONFIRMED || t.confidence === UR.LINK_CONFIDENCE.PROBABLE;
          return [
            accountLink(t.fromAccount),
            t.toAccount ? accountLink(t.toAccount) : ((t.candidateAccounts || []).length ? accountLinkList(t.candidateAccounts) : '-'),
            t.fromService + ' -> ' + (t.toService || t.expectedService || '?'),
            t.dischargeCode || '-',
            t.gapMinutes === null || t.gapMinutes === undefined ? '-' : util.round(t.gapMinutes, 0) + ' min',
            t.sameDay === null || t.sameDay === undefined ? '-' : (t.sameDay ? 'Yes' : 'No'),
            pill(t.confidence, accepted ? (t.confidence === UR.LINK_CONFIDENCE.CONFIRMED ? 'info' : 'warning') : 'warning'),
            t.issue || (accepted ? 'Accepted: exactly one account matched the expected service inside the configured tolerance.' : '')
          ];
        })));
    }

    /* ------------------------------------------------------ readmissions */
    if (dossier.readmissions.length) {
      host.appendChild(el('h4', { text: 'Readmission indicators' }));
      host.appendChild(el('p', { class: 'hint', text: 'Internal operational indicators only. Not a CMS readmission measure.' }));
      host.appendChild(table(
        ['Prior episode', 'Prior final discharge', 'Prior disposition', 'New IP account', 'New episode start', 'Days between', 'Within windows'],
        dossier.readmissions.map(function (r) {
          var within = [];
          Object.keys(r.within).forEach(function (k) { if (r.within[k]) { within.push(k + ' days'); } });
          return [r.priorEpisodeId, util.fmtDateTime(r.priorFinalDischarge), r.priorDisposition,
            accountLink(r.newIPAccount), util.fmtDateTime(r.newEpisodeStart), util.round(r.daysBetween, 2),
            within.join(', ') || 'none'];
        })));
    }

    /* ------------------------------------------------------------ visits */
    host.appendChild(el('h4', { text: 'Visits (' + dossier.visits.length + ')' }));
    dossier.visits.forEach(function (visit, index) {
      var e = visit.encounter;
      /* Collapsed by default: the summary line carries the account, service,
       * interval, and status, so the list scans without scrolling. */
      var open = false;

      var body = el('div', { class: 'visit-body' });

      body.appendChild(el('p', { class: 'hint', text:
        'Source: ' + e.sourceFile + '  |  sheet ' + e.sourceSheet + '  |  spreadsheet row ' + e.sourceRowNumber +
        '. Compare the middle column with the chart; the right column is what this tool derived from it.' }));

      body.appendChild(table(
        ['Field', 'Source column', 'Value as imported', 'Interpreted as'],
        visit.fields.map(function (row) {
          return [row.field, el('code', { text: row.column }), el('code', { text: row.rawValue }), row.interpreted];
        })));

      body.appendChild(el('h5', { text: 'Derived values' }));
      body.appendChild(table(['Value', 'Result'], visit.derived.map(function (d) {
        return [d.label + (d.note ? ' - ' + d.note : ''), d.value];
      })));

      if (visit.transitions.length) {
        body.appendChild(el('h5', { text: 'Transitions touching this visit' }));
        body.appendChild(table(['From', 'To', 'Gap', 'Result', 'Reason'], visit.transitions.map(function (t) {
          return [accountLink(t.fromAccount), t.toAccount ? accountLink(t.toAccount) : ((t.candidateAccounts || []).length ? accountLinkList(t.candidateAccounts) : '-'),
            t.gapMinutes === null || t.gapMinutes === undefined ? '-' : util.round(t.gapMinutes, 0) + ' min',
            t.confidence, t.issue || 'Accepted.'];
        })));
      }

      if (visit.reviewRows.length) {
        body.appendChild(el('h5', { text: 'On the review queue for' }));
        body.appendChild(table(['Rule ID', 'Reason', 'Detail'], visit.reviewRows.map(function (r) {
          return [ruleLink(r.ruleId), r.ruleName, r.detail];
        })));
      }

      if (visit.diagnostics.length) {
        body.appendChild(el('h5', { text: 'Diagnostics raised against this visit' }));
        body.appendChild(table(['Severity', 'Rule ID', 'Finding', 'Message'], visit.diagnostics.map(function (d) {
          return [pill(d.severity, d.severity.toLowerCase()), ruleLink(d.ruleId), d.name, d.message];
        })));
      } else {
        body.appendChild(el('p', { class: 'hint', text: 'No diagnostic was raised against this visit.' }));
      }

      if (e.serviceClass === UR.SERVICE.IP && !e.manualEntry && e.metricEligible) {
        body.appendChild(manualObsSection(e));
      }

      var statusPill = visit.status.label === 'Included'
        ? pill('Counted', 'info')
        : pill(visit.status.label, visit.status.label === 'Open' ? 'info' : 'warning');

      var details = el('details', { class: 'visit', open: open ? true : null }, [
        el('summary', null, [
          el('strong', { text: 'Visit ' + (index + 1) + ': account ' + e.account }),
          doc.createTextNode('  ' + e.serviceClass + '  |  ' + util.fmtDateTime(e.admitDT) +
            (e.isOpen ? ' -> (open)' : ' -> ' + util.fmtDateTime(e.dischargeDT)) +
            (e.durationHours === null ? '' : '  |  ' + util.round(e.durationHours, 1) + 'h') + '  '),
          statusPill,
          visit.status.detail ? el('span', { class: 'muted', text: '  ' + visit.status.detail }) : null
        ]),
        body
      ]);
      host.appendChild(details);
    });
  }

  /* ----------------------------------------- manual observation segments */

  /*
   * The manual-entry time fields take MILITARY time - the convention the
   * operator already reads in CPSI - through the same parser the importer
   * uses, so 830, 1430, 14:30, 2400, and even "2:30 PM" all mean what they
   * mean there. A datetime-local input would force the browser's 12-hour
   * picker instead.
   */
  function parseDateAndMilitaryTime(dateValue, timeValue) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
    if (!m) { return { error: 'a date is required' }; }
    var day = util.mkDT(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0);
    var t = UR.parsers.parseTime(String(timeValue === undefined ? '' : timeValue).trim());
    if (!t.ok) { return { error: 'the time could not be read - use military time such as 0830 or 1430 (' + t.reason + ')' }; }
    return { dt: new Date(day.getTime() + t.value * 60000) };
  }

  function militaryValue(dt) {
    if (!dt) { return ''; }
    return util.pad2(dt.getUTCHours()) + util.pad2(dt.getUTCMinutes());
  }

  function reprocessToAccounts() {
    ui.state = null;
    process();
    renderAccounts();
  }

  /*
   * CPSI sometimes exports a stay that began in observation as one IP account
   * with no OS row. This section on every IP visit lets the operator supply
   * the missing observation admit/discharge; the pipeline creates
   * <account>-MANUAL, links it as a normal OS -> IP conversion, moves the IP
   * admission forward to the observation discharge, notes the account, and
   * everything recalculates.
   */
  function manualObsSection(e) {
    var wrap = el('div', { class: 'manual-obs' });
    wrap.appendChild(el('h5', { text: 'Manual observation segment' }));

    var existing = null;
    ui.manualObservations.forEach(function (m) { if (m.account === e.account) { existing = m; } });

    if (existing) {
      wrap.appendChild(el('p', { class: 'hint', text:
        'Observation ' + util.fmtDateTime(existing.osAdmitDT) + ' to ' + util.fmtDateTime(existing.osDischargeDT) +
        ' was entered manually as account ' + e.account + '-MANUAL, and this inpatient admission was moved forward to the observation discharge. ' +
        'The entry lives only in this browser tab; correct CPSI for a durable fix.' }));
      wrap.appendChild(el('button', { type: 'button', onclick: function () {
        ui.manualObservations = ui.manualObservations.filter(function (m) { return m.account !== e.account; });
        reprocessToAccounts();
      } }, ['Remove manual observation & reprocess']));
      return wrap;
    }

    var seed = e.manualObsOriginalAdmit || e.admitDT;
    var admitDateInput = el('input', { type: 'date', value: seed ? util.fmtISODate(seed) : '' });
    var admitTimeInput = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'e.g. 1430', value: militaryValue(seed) });
    var disDateInput = el('input', { type: 'date', value: seed ? util.fmtISODate(seed) : '' });
    var disTimeInput = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'e.g. 1430' });
    var msg = el('p', { class: 'hint' });
    var form = el('div', { class: 'manual-obs-form' }, [
      el('p', { class: 'hint', text:
        'Enter the observation stay CPSI did not export, times in MILITARY time (0830, 1430, 2400) exactly as CPSI shows them. ' +
        'A new account ' + e.account + '-MANUAL will carry it, linked to this account as a normal OS -> IP conversion, ' +
        'and this inpatient admission will move forward to the observation discharge so the hours are not double-counted. ' +
        'Everything reprocesses immediately.' }),
      el('div', { class: 'manual-obs-row' }, [
        el('label', null, ['Observation admit date ', admitDateInput]),
        el('label', null, ['Time (military) ', admitTimeInput])
      ]),
      el('div', { class: 'manual-obs-row' }, [
        el('label', null, ['Observation discharge date ', disDateInput]),
        el('label', null, ['Time (military) ', disTimeInput])
      ]),
      el('button', { type: 'button', class: 'primary', onclick: function () {
        var admitRes = parseDateAndMilitaryTime(admitDateInput.value, admitTimeInput.value);
        var disRes = parseDateAndMilitaryTime(disDateInput.value, disTimeInput.value);
        if (admitRes.error) { msg.textContent = 'Observation admit: ' + admitRes.error + '.'; return; }
        if (disRes.error) { msg.textContent = 'Observation discharge: ' + disRes.error + '.'; return; }
        var osAdmit = admitRes.dt;
        var osDis = disRes.dt;
        if (osDis.getTime() <= osAdmit.getTime()) { msg.textContent = 'The observation discharge must come after the observation admission.'; return; }
        if (osDis.getTime() < e.admitDT.getTime()) { msg.textContent = 'The observation discharge precedes the recorded inpatient admission; the inpatient admission only moves forward.'; return; }
        if (e.dischargeDT && osDis.getTime() >= e.dischargeDT.getTime()) { msg.textContent = 'The observation discharge must precede the inpatient discharge.'; return; }
        ui.manualObservations.push({ account: e.account, osAdmitDT: osAdmit, osDischargeDT: osDis });
        reprocessToAccounts();
      } }, ['Apply & reprocess']),
      msg
    ]);
    form.hidden = true;

    wrap.appendChild(el('button', { type: 'button', onclick: function () {
      form.hidden = !form.hidden;
    } }, ['Add observation segment...']));
    wrap.appendChild(form);
    return wrap;
  }

  /* ------------------------------------------------------------- graphs */

  function renderGraphs() {
    if (!ui.state) { process(); }
    var host = $('graphs-body');
    var status = $('graphs-status');
    clear(host);

    if (ui.state.blocked) {
      host.appendChild(el('div', { class: 'msg msg-blocking', text: 'Processing was blocked, so there is nothing to graph. Open the Overview to see why.' }));
      $('btn-export-all-png').disabled = true;
      ui.chartCards = [];
      return;
    }
    $('btn-export-all-png').disabled = false;
    status.textContent = '';

    var specs = UR.chartData.all(ui.state);
    ui.chartCards = UR.charts.render(host, specs, {
      download: download,
      periodLabel: util.fmtISODate(ui.state.period.startDT),
      onRuleClick: openRuleReference,
      onExpand: expandChart
    });
    renderNav('graphs');
  }

  /*
   * A large single-chart view in the modal: the full modal width instead of a
   * grid cell, with the same tooltips, PNG export, and data table. Rendered
   * as transient so it never steals the grid's resize handling.
   */
  function expandChart(spec) {
    var body = el('div', { class: 'chart-expand' });
    openModal(spec.title, body);
    UR.charts.render(body, [spec], {
      download: download,
      periodLabel: ui.state && ui.state.period ? util.fmtISODate(ui.state.period.startDT) : '',
      onRuleClick: function (id) { closeModal(); openRuleReference(id); },
      transient: true
    });
  }

  /* ------------------------------------------------------------ 6. export */

  function renderExport() {
    if (!ui.state) { process(); }
    var host = $('export-summary');
    clear(host);
    var state = ui.state;

    if (state.blocked) {
      host.appendChild(el('div', { class: 'msg msg-blocking', text: 'Processing was blocked; there is nothing to export.' }));
      $('btn-export').disabled = true;
      return;
    }
    $('btn-export').disabled = false;
    $('opt-exclude-names').checked = !!ui.config.processing.excludePatientNames;

    var dq = state.diagnostics.counts();
    host.appendChild(el('p', null, [
      doc.createTextNode('Reporting period ' + state.period.label + '. '),
      doc.createTextNode(state.encounters.length + ' rows, ' + state.episodes.length + ' episodes, ' +
        state.reviewQueue.rows.length + ' review rows. ')
    ]));
    if (dq.Error || dq.Warning) {
      host.appendChild(el('div', { class: 'msg msg-warning' }, [
        el('strong', { text: 'Unresolved diagnostics' }),
        doc.createTextNode(dq.Error + ' error(s) and ' + dq.Warning + ' warning(s) will be exported with the workbook on the Data Quality worksheet.')
      ]));
    }
    host.appendChild(el('p', { class: 'hint', text: 'The workbook contains 18 worksheets and opens on a linked Contents page. Tabs are color-grouped, header rows are frozen and filterable, and long tables are banded for reading across. It has no macros and no external links.' }));
    renderNav('export');
  }

  function download(bytes, filename, mime) {
    var blob = new global.Blob([bytes], { type: mime });
    var url = global.URL.createObjectURL(blob);
    var link = el('a', { href: url, download: filename });
    doc.body.appendChild(link);
    link.click();
    doc.body.removeChild(link);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
  }

  /*
   * Everything needed to put the tool back exactly where it is now: the
   * source tables, the field-mapping selection, the configuration, the
   * period choice, and the manual observation entries. Embedded in the
   * exported workbook so re-importing it restores the session (spec: the
   * workbook already carries PHI, so the snapshot adds no new exposure -
   * EXCEPT when the operator excluded patient names, in which case no
   * snapshot is embedded at all, because it would smuggle the names back in).
   */
  function buildSnapshot(stamp) {
    function cellSafe(v) {
      if (v instanceof Date) { return util.fmtDateTime(v); }
      return v === undefined ? null : v;
    }
    return {
      kind: 'ur-compiler-snapshot',
      snapshotVersion: 1,
      app: UR.APP_VERSION,
      generatedAt: stamp.toISOString(),
      config: JSON.parse(UR.configSchema.toJSON(ui.config, stamp.toISOString())),
      selection: ui.selection,
      acknowledged: ui.acknowledged,
      sources: ui.sources.map(function (s) {
        return {
          fileName: s.fileName,
          sheetName: s.sheetName,
          headerRowIndex: s.headerRowIndex,
          headers: s.headers,
          rows: s.rows.map(function (r) { return { c: r.cells.map(cellSafe), n: r.sourceRowNumber }; })
        };
      }),
      period: {
        touched: ui.periodTouched,
        start: $('period-start').value || '',
        end: $('period-end').value || ''
      },
      manualObservations: ui.manualObservations.map(function (m) {
        return { account: m.account, osAdmit: m.osAdmitDT.toISOString(), osDischarge: m.osDischargeDT.toISOString() };
      }),
      serviceLogs: ui.files.filter(function (f) { return f.serviceLog; }).map(function (f) {
        return {
          fileName: f.fileName,
          reportRange: f.serviceLog.reportRange,
          facility: f.serviceLog.facility,
          rows: f.serviceLog.rows.map(function (r) {
            return { account: r.account, name: r.name, from: r.from, to: r.to,
                     change: r.changeDT ? r.changeDT.toISOString() : null,
                     rawDate: r.rawDate, rawTime: r.rawTime, initials: r.initials };
          }),
          unparsed: f.serviceLog.unparsed
        };
      })
    };
  }

  function exportWorkbook() {
    var status = $('export-status');
    status.textContent = 'Building workbook...';
    /* Yield once so the status paints before the synchronous build. */
    global.setTimeout(function () {
      try {
        var stamp = new Date();
        /* Render every populated graph to a PNG so the workbook carries the
         * charts, not just the numbers behind them. A canvas failure only
         * costs the Graphs sheet, never the export. */
        var chartImages = [];
        try {
          chartImages = UR.charts.exportImages(UR.chartData.all(ui.state), 900);
        } catch (imgErr) {
          chartImages = [];
        }
        var bytes = UR.workbookBuilder.toBytes(ui.state, stamp.toLocaleString(),
          { chartImages: chartImages });
        if (!ui.config.processing.excludePatientNames) {
          try {
            bytes = UR.zipPatch.embedSnapshot(bytes, JSON.stringify(buildSnapshot(stamp)));
          } catch (snapErr) { /* a workbook without a snapshot beats no workbook */ }
        }
        var name = 'UR-Compiled-' + util.fmtISODate(ui.state.period.startDT) + '-to-' +
          util.fmtISODate(new Date(ui.state.period.endExclusiveDT.getTime() - 1)) + '.xlsx';
        download(bytes, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        status.textContent = 'Workbook downloaded: ' + name;
      } catch (e) {
        status.textContent = 'Export failed: ' + (e && e.message ? e.message : String(e));
      }
    }, 30);
  }

  /* ------------------------------------------- calculation reference page */

  function renderCalcRef() {
    var records = UR.calculationReferenceSheet.records(ui.config);
    var filter = ($('calcref-filter').value || '').toLowerCase();
    var group = $('calcref-group').value;
    var host = $('calcref-body');
    clear(host);

    var shown = records.filter(function (r) {
      if (group && r.group !== group) { return false; }
      if (!filter) { return true; }
      var hay = (r.id + ' ' + r.name + ' ' + r.definition + ' ' + r.formula + ' ' + r.notes).toLowerCase();
      return hay.indexOf(filter) >= 0;
    });

    /*
     * A rule-link jump filters to the exact id. That id may also appear in
     * other rules' inputs and notes, so the exact match is put first and
     * highlighted: the rule asked for, then everything that cites it.
     */
    var exactId = null;
    shown.sort(function (a, b) {
      var ax = a.id.toLowerCase() === filter ? 0 : 1;
      var bx = b.id.toLowerCase() === filter ? 0 : 1;
      return ax - bx;
    });
    if (shown.length && shown[0].id.toLowerCase() === filter) { exactId = shown[0].id; }

    host.appendChild(el('p', { class: 'hint', text: shown.length + ' of ' + records.length + ' rules shown.' +
      (exactId ? ' ' + exactId + ' first; the rest cite it.' : '') }));

    shown.forEach(function (r) {
      var kind = r.classification === UR.CLASSIFICATION.REGULATORY ? 'regulatory'
        : (r.classification === UR.CLASSIFICATION.DATA_QUALITY ? 'warning'
          : (r.classification === UR.CLASSIFICATION.HOSPITAL ? 'hospital' : 'operational'));
      var dl = el('dl');
      function row(label, value) {
        if (!value || (value.length === 0)) { return; }
        dl.appendChild(el('dt', { text: label }));
        dl.appendChild(el('dd', { text: Object.prototype.toString.call(value) === '[object Array]' ? value.join(' ') : value }));
      }
      row('Definition', r.definition);
      row('Formula or logic', r.formula);
      row('Inputs', r.inputs);
      row('Inclusions', r.inclusions);
      row('Exclusions', r.exclusions);
      row('Thresholds', r.thresholds);
      row('Null / open handling', r.nullHandling);
      row('Source references', r.sourceRefs.map(function (id) {
        var ref = UR.referenceById(id);
        return ref ? ref.id + ' ' + ref.title : id;
      }));
      row('Notes', r.notes);

      host.appendChild(el('div', { class: 'rule-card' + (exactId === r.id ? ' exact' : '') }, [
        el('h4', null, [
          el('span', { class: 'rule-id', text: r.id + ' v' + r.version + ' ' }),
          doc.createTextNode(r.name), doc.createTextNode(' '),
          pill(r.classification, kind)
        ]),
        dl
      ]));
    });

    var refs = $('calcref-refs');
    clear(refs);
    refs.appendChild(table(['Reference', 'Title', 'Note', 'Source'],
      UR.REFERENCES.map(function (ref) {
        return [ref.id, ref.title, ref.note, ref.url || '(hospital policy)'];
      })));
    refs.appendChild(el('p', { class: 'hint', text: 'These references support the initial regulatory-surveillance design and should be rechecked when calculation rules or payer workflows are revised. This software is not a substitute for current CMS, payer, contract, or Arkansas regulatory guidance.' }));
    renderNav('calcref');
  }

  /* -------------------------------------------------------- configuration */

  function loadConfig() {
    var loaded = UR.configSchema.load();
    if (loaded.ok && loaded.config) {
      ui.config = loaded.config;
      ui.configStatus = 'Loaded saved configuration version ' + ui.config.configVersion + ' from this browser.';
    } else {
      ui.config = UR.configSchema.defaults();
      ui.configStatus = 'Using built-in defaults.';
    }
  }

  function exportConfig() {
    var json = UR.configSchema.toJSON(ui.config, new Date().toISOString());
    download(new global.Blob([json]), 'ur-compiler-config-v' + ui.config.configVersion + '.json', 'application/json');
    ui.configStatus = 'Configuration exported.';
    renderRules();
  }

  function importConfig(file) {
    var reader = new global.FileReader();
    reader.onload = function (ev) {
      var parsed;
      try {
        parsed = JSON.parse(ev.target.result);
      } catch (e) {
        ui.configStatus = 'That file is not readable JSON.';
        renderRules();
        return;
      }
      var result = UR.configSchema.validate(parsed);
      if (!result.ok) {
        ui.configStatus = 'Configuration rejected: ' + result.errors.join(' ');
      } else {
        ui.config = result.config;
        ui.state = null;
        ui.configStatus = 'Configuration version ' + ui.config.configVersion + ' imported.' +
          (result.warnings.length ? ' ' + result.warnings.join(' ') : '');
      }
      renderRules();
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------- wiring */

  function wire() {
    $('version-line').textContent = 'Application ' + UR.APP_VERSION + ' | ruleset ' + UR.RULESET_VERSION;

    var dropzone = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove('dragover'); });
    });
    dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) { handleFiles(e.dataTransfer.files); }
    });
    $('file-input').addEventListener('change', function (e) { handleFiles(e.target.files); });

    $('btn-to-mapping').addEventListener('click', tryAutoProcess);
    $('btn-adjust-mapping').addEventListener('click', function () { goTo('map'); });
    $('btn-back-import').addEventListener('click', function () { goTo('import'); });
    $('btn-to-rules').addEventListener('click', function () { ui.state = null; goTo('overview'); });
    $('btn-back-map').addEventListener('click', function () { goTo('map'); });
    $('btn-to-validate').addEventListener('click', function () { ui.state = null; goTo('overview'); });
    $('btn-to-results').addEventListener('click', function () { goTo('results'); });
    $('btn-back-validate').addEventListener('click', function () { goTo('overview'); });
    $('btn-overview-review').addEventListener('click', function () { goTo('review'); });
    $('btn-overview-export').addEventListener('click', function () { goTo('export'); });
    $('btn-results-review').addEventListener('click', function () { goTo('review'); });
    $('btn-review-overview').addEventListener('click', function () { goTo('overview'); });
    $('btn-review-export').addEventListener('click', function () { goTo('export'); });
    $('review-search').addEventListener('input', renderReview);
    $('review-rule').addEventListener('change', function (ev) { ui.reviewRuleFilter = ev.target.value; renderReview(); });
    $('btn-to-export').addEventListener('click', function () { goTo('export'); });
    $('btn-back-results').addEventListener('click', function () { goTo('results'); });
    $('btn-to-graphs').addEventListener('click', function () { goTo('graphs'); });
    $('btn-graphs-from-export').addEventListener('click', function () { goTo('graphs'); });
    $('account-search').addEventListener('input', renderAccounts);
    $('account-service').addEventListener('change', renderAccounts);
    $('account-status').addEventListener('change', renderAccounts);
    $('btn-accounts-from-results').addEventListener('click', function () { goTo('accounts'); });
    $('btn-export-all-png').addEventListener('click', function () {
      var status = $('graphs-status');
      if (!ui.chartCards || !ui.chartCards.length) { return; }
      status.textContent = 'Saving graphs...';
      UR.charts.exportAll(ui.chartCards, download, function (done, total) {
        status.textContent = done === total ? 'Saved ' + total + ' PNG file(s).' : 'Saved ' + done + ' of ' + total + '...';
      });
    });
    $('period-start').addEventListener('change', function () { ui.periodTouched = true; });
    $('period-end').addEventListener('change', function () { ui.periodTouched = true; });
    $('btn-reprocess').addEventListener('click', function () { ui.state = null; renderOverview(); });
    $('btn-export').addEventListener('click', exportWorkbook);

    $('opt-exclude-names').addEventListener('change', function (e) {
      ui.config.processing.excludePatientNames = e.target.checked;
    });

    $('btn-config-export').addEventListener('click', exportConfig);
    $('config-import').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) { importConfig(e.target.files[0]); }
    });
    $('btn-config-save').addEventListener('click', function () {
      var res = UR.configSchema.save(ui.config);
      ui.configStatus = res.ok
        ? 'Saved to this browser. Export the JSON as well: browser storage can be cleared by IT policy or a workstation rebuild.'
        : res.reason;
      renderRules();
    });
    $('btn-config-reset').addEventListener('click', function () {
      ui.config = UR.configSchema.defaults();
      ui.state = null;
      ui.configStatus = 'Reset to built-in defaults.';
      renderRules();
    });

    $('link-calcref-from-rules').addEventListener('click', function (e) { e.preventDefault(); goTo('calcref'); });
    $('calcref-filter').addEventListener('input', renderCalcRef);
    $('calcref-group').addEventListener('change', renderCalcRef);

    $('modal-close').addEventListener('click', closeModal);
    $('modal-backdrop').addEventListener('click', function (e) {
      if (e.target === $('modal-backdrop')) { closeModal(); }
    });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); } });

    if (!global.XLSX) {
      $('offline-badge').textContent = 'Spreadsheet library missing';
      $('file-list').appendChild(el('div', { class: 'msg msg-blocking' }, [
        el('strong', { text: 'vendor/xlsx.full.min.js did not load' }),
        doc.createTextNode('Keep the vendor folder beside index.html. The application cannot read or write spreadsheets without it.')
      ]));
    }
  }

  function init() {
    loadConfig();
    wire();
    renderFileList();
    showStep('import');
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);

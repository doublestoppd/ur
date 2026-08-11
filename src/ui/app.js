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
    configStatus: ''
  };

  var STEPS = [
    { id: 'import', label: '1. Import' },
    { id: 'map', label: '2. Map fields' },
    { id: 'rules', label: '3. Rules & codes' },
    { id: 'validate', label: '4. Validate' },
    { id: 'results', label: '5. Results' },
    { id: 'export', label: '6. Export' },
    { id: 'calcref', label: 'Calculation Reference' }
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

  function severityClass(severity) {
    return 'msg msg-' + String(severity).toLowerCase();
  }

  function pill(text, kind) { return el('span', { class: 'pill pill-' + kind, text: text }); }

  function num(v, places) {
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) { return '-'; }
    return String(util.round(v, places === undefined ? 2 : places));
  }

  function pct(v) { return v === null || v === undefined ? '-' : util.round(v, 1) + '%'; }

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
    return !!ui.state && !ui.state.blocked;
  }

  function renderNav(active) {
    var nav = $('step-nav');
    clear(nav);
    STEPS.forEach(function (s) {
      var available = stepAvailable(s.id) || s.id === active;
      nav.appendChild(el('button', {
        type: 'button',
        class: s.id === active ? 'active' : '',
        disabled: available ? null : true,
        onclick: function () { if (available) { goTo(s.id); } }
      }, [s.label]));
    });
  }

  function goTo(id) {
    if (id === 'map') { renderMapping(); }
    if (id === 'rules') { renderRules(); }
    if (id === 'validate') { renderValidate(); }
    if (id === 'results') { renderResults(); }
    if (id === 'export') { renderExport(); }
    if (id === 'calcref') { renderCalcRef(); }
    showStep(id);
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
    global.Promise.all(files.map(readFile)).then(function (results) {
      results.forEach(function (r) { ui.files.push(r); });
      rebuildSources();
      renderFileList();
    });
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
      card.appendChild(el('div', { class: 'file-name', text: file.fileName }));

      if (file.error) {
        card.appendChild(el('div', { class: 'msg msg-error', text: file.error }));
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
          rebuildSources();
          renderFileList();
        }
      }, ['Remove file']));
      host.appendChild(card);
    });

    $('btn-to-mapping').disabled = ui.sources.length === 0;
    renderNav('import');
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

    if (ui.autoResult && ui.autoResult.ambiguities.length) {
      ui.autoResult.ambiguities.forEach(function (a) {
        messages.appendChild(el('div', { class: 'msg msg-warning' }, [
          el('strong', { text: 'Ambiguous header - choose manually' }),
          doc.createTextNode(a.reason + ' Candidates: ' + a.columns.join(', ') + '.')
        ]));
      });
    }
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
    var host = $('mapping-table');
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

    host.appendChild(thead);
    host.appendChild(body);
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

  /* Value frequency in the loaded data, shown beside each mapping row. */
  function frequencies(fieldKey) {
    var counts = {};
    ui.sources.forEach(function (source) {
      source.rows.forEach(function (row) {
        var v = UR.spreadsheetReader.cellFor(row, source.mapping, fieldKey);
        var key = util.codeKey(v);
        if (key === '') { return; }
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return counts;
  }

  function renderRules() {
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

  function markConfigChanged(message) {
    UR.configSchema.bumpVersion(ui.config);
    ui.state = null;
    ui.configStatus = message || ('Configuration version ' + ui.config.configVersion + ' (unsaved).');
    renderRules();
  }

  function unmappedNotice(fieldKey, listKey, factory) {
    var counts = frequencies(fieldKey);
    var missing = Object.keys(counts).filter(function (code) {
      return !ui.config[listKey].some(function (r) { return util.codeKey(r.code) === code; });
    });
    if (!missing.length) { return null; }
    return el('div', { class: 'msg msg-warning' }, [
      el('strong', { text: missing.length + ' value(s) in the loaded data are not mapped' }),
      doc.createTextNode(missing.join(', ') + '. '),
      el('button', {
        type: 'button', class: 'link',
        onclick: function () {
          missing.forEach(function (code) { ui.config[listKey].push(factory(code)); });
          markConfigChanged('Added ' + missing.length + ' unmapped value(s) for editing.');
        }
      }, ['Add them for editing'])
    ]);
  }

  function renderServiceCodes() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'IP, OS, and SB are included by default. Every other code is excluded; mark a code as Ignore to record that the exclusion is intentional rather than an unknown.' }));
    var notice = unmappedNotice('service', 'serviceCodes', function (code) {
      return { code: code, label: '', behavior: UR.SERVICE.IGNORED, enabled: true };
    });
    if (notice) { wrap.appendChild(notice); }

    var counts = frequencies('service');
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
        counts[util.codeKey(row.code)] || 0,
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
    var notice = unmappedNotice('dischargeCode', 'dischargeCodes', function (code) {
      return { code: code, label: '', category: 'Other', transitionTo: null, enabled: true };
    });
    if (notice) { wrap.appendChild(notice); }

    var counts = frequencies('dischargeCode');
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
        counts[util.codeKey(row.code)] || 0,
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

  function renderInsuranceCodes() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'Payer category drives the Medicare notice and two-midnight review rules. An unmapped code reports as Unknown and is excluded from those rules rather than being guessed.' }));
    var notice = unmappedNotice('insurance', 'insuranceCodes', UR.defaultMappings.blankInsurance);
    if (notice) { wrap.appendChild(notice); }

    var counts = frequencies('insurance');
    var categories = UR.PAYER_CATEGORY_LIST.map(function (c) { return { value: c, label: c }; });
    var rows = ui.config.insuranceCodes.map(function (row, i) {
      return [
        editText(row, 'code', function () { markConfigChanged(); }),
        editText(row, 'label', function () { markConfigChanged(); }),
        editSelect(row, 'category', categories, function () { markConfigChanged(); }),
        counts[util.codeKey(row.code)] || 0,
        editCheckbox(row, 'enabled', function () { markConfigChanged(); }),
        removeButton('insuranceCodes', i)
      ];
    });
    wrap.appendChild(table(['Code', 'Display name', 'Payer category', 'Rows in data', 'Enabled', ''], rows, { numeric: ['Rows in data'] }));
    wrap.appendChild(addButton('insuranceCodes', function () { return UR.defaultMappings.blankInsurance(''); }));
    return wrap;
  }

  function renderAdmissionSources() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'hint', text: 'No default admission-source mappings were supplied by the hospital. Values found in the data are inventoried and stay Unknown until mapped here.' }));
    var notice = unmappedNotice('admissionSource', 'admissionSources', UR.defaultMappings.blankAdmissionSource);
    if (notice) { wrap.appendChild(notice); }

    var counts = frequencies('admissionSource');
    var rows = ui.config.admissionSources.map(function (row, i) {
      return [
        editText(row, 'code', function () { markConfigChanged(); }),
        editText(row, 'label', function () { markConfigChanged(); }),
        editText(row, 'category', function () { markConfigChanged(); }),
        counts[util.codeKey(row.code)] || 0,
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
      ['CAH acute target (hours)', editNumber(th, 'acuteTargetHours', function () { markConfigChanged(); }), 'CAH96_001, IP_GT4_001, IP_EXCESS_001, RQ_IP_GT4'],
      ['Operational target (days)', editNumber(th, 'acuteTargetDays', function () { markConfigChanged(); }), 'IP_TARGET_001'],
      ['Observation thresholds (hours)', editList(th, 'obsThresholdHours', function () { markConfigChanged(); }), 'OS_24_001, OS_36_001, OS_48_001, RQ_OS_*'],
      ['One-day stay ceiling (hours)', editNumber(th, 'oneDayStayHours', function () { markConfigChanged(); }), 'IP_SHORT_001, RQ_1DAY'],
      ['Short-stay midnight threshold', editNumber(th, 'shortStayMidnights', function () { markConfigChanged(); }), 'IP_2MN_001, RQ_SHORT_MCR'],
      ['MOON screening threshold (hours)', editNumber(th, 'moonThresholdHours', function () { markConfigChanged(); }), 'RQ_MOON'],
      ['Readmission windows (days)', editList(th, 'readmissionWindowDays', function () { markConfigChanged(); }), 'READMIT_7_001, READMIT_30_001, READMIT_MCR_001']
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

  /* ---------------------------------------------------------- 4. validate */

  function process() {
    var options = {};
    var startValue = $('period-start').value;
    var endValue = $('period-end').value;
    if (startValue && endValue) {
      options.periodStart = parseDateInput(startValue);
      options.periodEnd = parseDateInput(endValue);
    }
    ui.state = UR.pipeline.process(ui.sources, ui.config, options);
    return ui.state;
  }

  function parseDateInput(value) {
    var parts = String(value).split('-');
    return util.mkDT(Number(parts[0]), Number(parts[1]), Number(parts[2]), 0, 0);
  }

  function renderValidate() {
    if (!ui.state) { process(); }
    var state = ui.state;

    if (state.period) {
      if (!$('period-start').value) { $('period-start').value = util.fmtISODate(state.period.startDT); }
      if (!$('period-end').value) { $('period-end').value = util.fmtISODate(new Date(state.period.endExclusiveDT.getTime() - 1)); }
      $('period-hint').textContent = 'Period ' + state.period.label + ' | occupancy as of ' + util.fmtDateTime(state.period.asOf);
    } else if (state.inferredPeriod) {
      $('period-hint').textContent = 'Detected range ' + state.inferredPeriod.label;
    }

    var summary = $('validate-summary');
    clear(summary);

    if (state.blocked) {
      summary.appendChild(el('div', { class: 'msg msg-blocking' }, [
        el('strong', { text: 'Processing stopped' }),
        doc.createTextNode('One or more blocking issues must be resolved before any metric can be calculated.')
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

    var host = $('validate-diagnostics');
    clear(host);
    var byRule = state.diagnostics.byRule(6);

    host.appendChild(el('h3', { text: 'Diagnostics' }));
    if (!byRule.length) {
      host.appendChild(el('p', { class: 'msg msg-info', text: 'No diagnostic was raised for this run.' }));
    } else {
      UR.SEVERITY_ORDER.forEach(function (severity) {
        var group = byRule.filter(function (g) { return g.severity === severity; });
        if (!group.length) { return; }
        host.appendChild(el('h3', null, [
          pill(severity, severity.toLowerCase()),
          doc.createTextNode(' ' + group.length + ' rule(s)')
        ]));
        host.appendChild(table(['Rule ID', 'Finding', 'Count', 'Sample accounts', 'Effect', ''],
          group.map(function (g) {
            var rule = UR.dataQualityRules.byId(g.ruleId);
            return [
              g.ruleId, g.name, g.count, g.samples.join(', '), rule ? rule.effect : '',
              el('button', {
                type: 'button', class: 'link',
                onclick: function () { showDiagnosticDetail(g.ruleId); }
              }, ['Show rows'])
            ];
          }), { numeric: ['Count'] }));
      });
    }

    if (state.codeInventory && state.codeInventory.length) {
      host.appendChild(el('h3', { text: 'Code inventory' }));
      host.appendChild(el('p', { class: 'hint', text: 'Every distinct code encountered, with the behavior applied. Resolve anything marked Unrecognized before treating a run as final.' }));
      state.codeInventory.forEach(function (section) {
        host.appendChild(el('h3', { text: section.type + (section.mapped ? '' : ' (column not mapped)') }));
        host.appendChild(table(['Value', 'Count', 'Configured meaning', 'Behavior', 'Status', 'Sample accounts'],
          section.rows.map(function (r) {
            return [r.value, r.count, r.mappedTo || '', r.behavior,
              r.status === UR.codeInventory.STATUS.UNRECOGNIZED ? pill(r.status, 'warning') : r.status,
              r.samples.join(', ')];
          }), { numeric: ['Count'], scroll: section.rows.length > 12 }));
      });
    }

    $('btn-to-results').disabled = !!state.blocked;
    renderNav('validate');
  }

  function showDiagnosticDetail(ruleId) {
    var items = ui.state.diagnostics.all().filter(function (d) { return d.ruleId === ruleId; });
    var rule = UR.dataQualityRules.byId(ruleId);
    var body = el('div');
    if (rule) {
      body.appendChild(el('p', null, [el('strong', { text: rule.description }), doc.createTextNode(' ' + rule.effect)]));
    }
    body.appendChild(table(['Account', 'MRN', 'Service', 'Message', 'Source file', 'Row'],
      items.map(function (d) { return [d.account, d.mrn, d.service, d.message, d.sourceFile, d.sourceRow]; }),
      { scroll: true }));
    openModal(ruleId + ' - ' + (rule ? rule.name : ''), body);
  }

  /* ----------------------------------------------------------- 5. results */

  function card(label, value, ruleId, note, onDetail) {
    var node = el('div', { class: 'metric-card' }, [
      el('span', { class: 'metric-label', text: label }),
      el('span', { class: 'metric-value', text: value === null || value === undefined ? '-' : String(value) })
    ]);
    if (ruleId) { node.appendChild(el('span', { class: 'metric-rule', text: ruleId })); }
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
      ['Account', 'MRN', 'Patient name', 'Service', 'Admit', 'Discharge', 'LOS hours', 'Midnights', 'Payer', 'Discharge code', 'Episode'],
      encounters.map(function (e) {
        return [e.account, e.mrn, e.name, e.serviceClass, util.fmtDateTime(e.admitDT),
          e.isOpen ? '(open)' : util.fmtDateTime(e.dischargeDT), num(e.durationHours, 1),
          e.midnights, e.payerCategory, e.dischargeCodeRaw, e.episodeId || ''];
      }), { scroll: true }));
    openModal(title, body);
  }

  function renderResults() {
    if (!ui.state) { process(); }
    var state = ui.state;
    var host = $('results-body');
    clear(host);
    if (state.blocked) {
      host.appendChild(el('div', { class: 'msg msg-blocking', text: 'Processing was blocked. Return to Validate to see why.' }));
      return;
    }

    var m = state.metrics;
    var th = ui.config.thresholds;

    host.appendChild(el('p', { class: 'hint', text: 'Reporting period ' + state.period.label + '. Values are calculated from the imported rows only; every figure names the rule that produced it.' }));

    host.appendChild(el('h3', { text: 'CAH acute inpatient' }));
    host.appendChild(el('div', { class: 'summary-grid' }, [
      card('Acute IP admissions', m.inpatient.IP_ADM_001.value, 'IP_ADM_001', 'Service accounts, includes status changes',
        function () { showRows('IP_ADM_001 - acute inpatient admissions', m.inpatient.IP_ADM_001.encounters); }),
      card('Mean acute LOS (hours)', num(m.inpatient.IP_ALOS_001.hours, 1), 'IP_ALOS_001', num(m.inpatient.IP_ALOS_001.days, 2) + ' days over ' + m.inpatient.IP_ALOS_001.n + ' discharges',
        function () { showRows('IP_ALOS_001 - qualifying discharged IP accounts', m.inpatient.IP_LOS_001.encounters); }),
      card('Median acute LOS (hours)', num(m.inpatient.IP_MEDLOS_001.hours, 1), 'IP_MEDLOS_001', ''),
      card(th.acuteTargetHours + 'h surveillance variance', num(m.inpatient.CAH96_001.varianceHours, 1), 'CAH96_001',
        'Surveillance estimate; the CAH requirement is an annual average'),
      card('Stays > ' + th.acuteTargetHours + 'h', m.inpatient.IP_GT4_001.value, 'IP_GT4_001', pct(m.inpatient.IP_GT4_001.percent) + ' of discharges',
        function () {
          showRows('IP_GT4_001 - stays over target', m.inpatient.IP_GT4_001.detail.map(function (d) { return d.encounter; }));
        }),
      card('Excess days above target', num(m.inpatient.IP_EXCESS_001.totalDays, 2), 'IP_EXCESS_001', ''),
      card('One-day acute stays', m.inpatient.IP_SHORT_001.value, 'IP_SHORT_001', payerBreakdown(m.inpatient.IP_SHORT_001.byPayer),
        function () { showRows('IP_SHORT_001 - one-day acute stays', m.inpatient.IP_SHORT_001.encounters); }),
      card('Medicare/MA under ' + th.shortStayMidnights + ' midnights', m.inpatient.IP_2MN_001.value, 'IP_2MN_001', 'Review candidates only',
        function () { showRows('IP_2MN_001 - short Medicare inpatient stays', m.inpatient.IP_2MN_001.encounters); })
    ]));

    host.appendChild(el('h3', { text: 'Observation' }));
    host.appendChild(el('div', { class: 'summary-grid' }, [
      card('Observation admissions', m.observation.OS_ADM_001.value, 'OS_ADM_001', '',
        function () { showRows('OS_ADM_001 - observation admissions', m.observation.OS_ADM_001.encounters); }),
      card('Mean duration (hours)', num(m.observation.OS_ALOS_001.meanHours, 1), 'OS_ALOS_001',
        'Median ' + num(m.observation.OS_ALOS_001.medianHours, 1) + 'h'),
      card('Over ' + th.obsThresholdHours[0] + 'h', m.observation.OS_24_001.value, 'OS_24_001', '',
        function () { showRows('OS_24_001', m.observation.OS_24_001.encounters); }),
      card('Over ' + th.obsThresholdHours[1] + 'h', m.observation.OS_36_001.value, 'OS_36_001', '',
        function () { showRows('OS_36_001', m.observation.OS_36_001.encounters); }),
      card('Over ' + th.obsThresholdHours[2] + 'h', m.observation.OS_48_001.value, 'OS_48_001', '',
        function () { showRows('OS_48_001', m.observation.OS_48_001.encounters); }),
      card('OS -> IP conversions', m.observation.OSIP_001.value, 'OSIP_001', ''),
      card('Conversion rate', pct(m.observation.OSIP_RATE_001.value), 'OSIP_RATE_001', m.observation.OSIP_RATE_001.denominatorNote),
      card('Mean hours before conversion', num(m.observation.OSIP_TIME_001.meanHours, 1), 'OSIP_TIME_001', '')
    ]));

    host.appendChild(el('h3', { text: 'Swing bed' }));
    host.appendChild(el('div', { class: 'summary-grid' }, [
      card('Swing-bed admissions', m.swingBed.SB_ADM_001.value, 'SB_ADM_001', '',
        function () { showRows('SB_ADM_001 - swing-bed admissions', m.swingBed.SB_ADM_001.encounters); }),
      card('Mean LOS (days)', num(m.swingBed.SB_ALOS_001.meanDays, 2), 'SB_ALOS_001', 'Median ' + num(m.swingBed.SB_ALOS_001.medianDays, 2) + ' days'),
      card('IP -> SB', m.swingBed.IPSB_001.value, 'IPSB_001', ''),
      card('SB -> IP', m.swingBed.SBIP_001.value, 'SBIP_001', 'Hospital-specific use of code V'),
      card('OS -> SB', m.swingBed.OSSB_001.value, 'OSSB_001', '')
    ]));

    host.appendChild(el('h3', { text: 'Volume, patient days, and census' }));
    host.appendChild(el('p', { class: 'hint', text: 'Two patient-day methods are reported on purpose. Compare both against the existing UR workbook before naming either one the official hospital measure.' }));
    host.appendChild(el('div', { class: 'summary-grid' }, [
      card('Service admissions', m.census.ADM_SVC_001.value, 'ADM_SVC_001', m.census.ADM_SVC_001.note),
      card('Unique episodes', m.census.EPISODE_CNT_001.value, 'EPISODE_CNT_001', 'Recommended headline count'),
      card('Unique patients', m.census.PATIENT_CNT_001.value, 'PATIENT_CNT_001', ''),
      card('Equivalent patient days', num(m.census.PD_EQ_001.value, 2), 'PD_EQ_001', 'Time-weighted'),
      card('Midnight patient days', m.census.PD_MN_001.value, 'PD_MN_001', 'Midnight census'),
      card('Time-weighted ADC', num(m.census.ADC_EQ_001.value, 2), 'ADC_EQ_001', ''),
      card('Midnight ADC', num(m.census.ADC_MN_001.value, 2), 'ADC_MN_001', ''),
      card('Deaths', m.payer.DEATH_001.value, 'DEATH_001', pct(m.payer.DEATH_001.percent) + ' of discharges',
        function () { showRows('DEATH_001 - deaths', m.payer.DEATH_001.encounters); })
    ]));

    var readmits = UR.pipeline.readmissionsInPeriod(state, state.period);
    host.appendChild(el('h3', { text: 'Readmission indicators (internal operational only)' }));
    host.appendChild(el('div', { class: 'summary-grid' }, [
      card('Within ' + th.readmissionWindowDays[0] + ' days', readmits.short, 'READMIT_7_001', 'Not a CMS readmission rate'),
      card('Within ' + th.readmissionWindowDays[1] + ' days', readmits.long, 'READMIT_30_001', 'Not a CMS readmission rate'),
      card('Medicare within ' + th.readmissionWindowDays[1] + ' days', readmits.medicare, 'READMIT_MCR_001', '')
    ]));

    host.appendChild(el('h3', { text: 'Review queue' }));
    host.appendChild(el('p', { class: 'hint', text: state.reviewQueue.rows.length + ' review row(s) across ' + state.reviewQueue.byAccount.length + ' account(s). These identify cases to look at; they express no clinical, medical-necessity, denial, or compliance conclusion.' }));
    host.appendChild(table(['Rule ID', 'Review reason', 'Accounts', ''],
      UR.reviewRules.ids().map(function (id) {
        var rule = UR.reviewRules.byId(id);
        var count = state.reviewQueue.counts[id] || 0;
        return [id, rule.name, count, count
          ? el('button', { type: 'button', class: 'link', onclick: function () { showReviewRows(id); } }, ['Show accounts'])
          : ''];
      }), { numeric: ['Accounts'] }));

    host.appendChild(el('h3', { text: 'Transitions' }));
    host.appendChild(table(['Prior account', 'Next account', 'Services', 'Discharge code', 'Gap (min)', 'Confidence', 'Episode', 'Issue'],
      state.transitions.map(function (t) {
        var from = null;
        state.encounters.forEach(function (e) { if (e.rowId === t.fromRowId) { from = e; } });
        return [t.fromAccount, t.toAccount || (t.candidateAccounts || []).join(', '),
          t.fromService + ' -> ' + (t.toService || t.expectedService || '?'), t.dischargeCode,
          t.gapMinutes === null ? '' : util.round(t.gapMinutes, 0),
          t.confidence === UR.LINK_CONFIDENCE.CONFIRMED ? t.confidence : pill(t.confidence, t.confidence === UR.LINK_CONFIDENCE.PROBABLE ? 'info' : 'warning'),
          from ? (from.episodeId || '') : '', t.issue];
      }), { scroll: state.transitions.length > 12 }));

    renderNav('results');
  }

  function payerBreakdown(byPayer) {
    var parts = [];
    Object.keys(byPayer).forEach(function (k) { parts.push(k + ': ' + byPayer[k]); });
    return parts.join(', ');
  }

  function showReviewRows(ruleId) {
    var rule = UR.reviewRules.byId(ruleId);
    var rows = ui.state.reviewQueue.rows.filter(function (r) { return r.ruleId === ruleId; });
    var body = el('div');
    body.appendChild(el('p', null, [el('strong', { text: rule.trigger })]));
    body.appendChild(el('p', { class: 'hint', text: rule.notes }));
    body.appendChild(table(['Account', 'MRN', 'Patient name', 'Service', 'Payer', 'Admit', 'Discharge', rule.id === 'RQ_DATA' ? 'Severity' : 'Measure', 'Detail'],
      rows.map(function (r) {
        return [r.account, r.mrn, r.patientName, r.service, r.payerCategory,
          util.fmtDateTime(r.admit), r.isOpen ? '(open)' : util.fmtDateTime(r.discharge),
          r.ruleId === 'RQ_DATA' ? (r.severity || '') : num(r.measure, 1), r.detail];
      }), { scroll: true }));
    openModal(ruleId + ' - ' + rule.name, body);
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
    host.appendChild(el('p', { class: 'hint', text: 'The workbook contains 17 worksheets including the Review Queue, detail sheets, Data Quality, Code Inventory, Calculation Reference, and Run Metadata. It has no macros and no external links.' }));
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

  function exportWorkbook() {
    var status = $('export-status');
    status.textContent = 'Building workbook...';
    /* Yield once so the status paints before the synchronous build. */
    global.setTimeout(function () {
      try {
        var stamp = new Date();
        var bytes = UR.workbookBuilder.toBytes(ui.state, stamp.toLocaleString());
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

    host.appendChild(el('p', { class: 'hint', text: shown.length + ' of ' + records.length + ' rules shown.' }));

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

      host.appendChild(el('div', { class: 'rule-card' }, [
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

    $('btn-to-mapping').addEventListener('click', function () { goTo('map'); });
    $('btn-back-import').addEventListener('click', function () { goTo('import'); });
    $('btn-to-rules').addEventListener('click', function () { goTo('rules'); });
    $('btn-back-map').addEventListener('click', function () { goTo('map'); });
    $('btn-to-validate').addEventListener('click', function () { ui.state = null; goTo('validate'); });
    $('btn-back-rules').addEventListener('click', function () { goTo('rules'); });
    $('btn-to-results').addEventListener('click', function () { goTo('results'); });
    $('btn-back-validate').addEventListener('click', function () { goTo('validate'); });
    $('btn-to-export').addEventListener('click', function () { goTo('export'); });
    $('btn-back-results').addEventListener('click', function () { goTo('results'); });
    $('btn-reprocess').addEventListener('click', function () { ui.state = null; renderValidate(); });
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

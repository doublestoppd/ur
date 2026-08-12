/*
 * zipPatch.js - post-write patcher that adds frozen header panes, cell styling,
 * and sheet-tab colors to the generated workbook (spec 13).
 *
 * The bundled Apache-2.0 spreadsheet library writes number formats, column
 * widths, and autofilters, but no fonts, fills, or tab colors - so this module
 * rewrites styles.xml and the worksheet XML after the workbook bytes are
 * produced. The builder decides WHAT to style (it knows each sheet's layout);
 * this module only knows HOW, so the two cannot disagree about a row's meaning.
 *
 * It only handles STORED (uncompressed) zip entries, which is what the library
 * emits by default. If it ever encounters a compressed entry it returns the
 * original bytes untouched: a workbook without styling is a small cosmetic
 * loss, whereas a corrupted workbook is not acceptable.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  var LOCAL_SIG = 0x04034b50;
  var CENTRAL_SIG = 0x02014b50;
  var EOCD_SIG = 0x06054b50;

  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0 ^ (-1);
    for (var i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ (-1)) >>> 0;
  }

  function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
  function u32(buf, off) { return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0; }

  function putU16(buf, off, v) { buf[off] = v & 0xFF; buf[off + 1] = (v >>> 8) & 0xFF; }
  function putU32(buf, off, v) {
    buf[off] = v & 0xFF; buf[off + 1] = (v >>> 8) & 0xFF;
    buf[off + 2] = (v >>> 16) & 0xFF; buf[off + 3] = (v >>> 24) & 0xFF;
  }

  function encodeUTF8(text) {
    if (typeof TextEncoder !== 'undefined') { return new TextEncoder().encode(text); }
    var utf = unescape(encodeURIComponent(text));
    var out = new Uint8Array(utf.length);
    for (var i = 0; i < utf.length; i++) { out[i] = utf.charCodeAt(i) & 0xFF; }
    return out;
  }

  function decodeUTF8(bytes) {
    if (typeof TextDecoder !== 'undefined') { return new TextDecoder('utf-8').decode(bytes); }
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return decodeURIComponent(escape(s));
  }

  /* Parse a zip into entries. Returns null when anything is unsupported. */
  function parseZip(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
      if (u32(bytes, i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) { return null; }

    var count = u16(bytes, eocd + 10);
    var cdOffset = u32(bytes, eocd + 16);
    var entries = [];
    var p = cdOffset;

    for (var n = 0; n < count; n++) {
      if (u32(bytes, p) !== CENTRAL_SIG) { return null; }
      var method = u16(bytes, p + 10);
      var modTime = u16(bytes, p + 12);
      var modDate = u16(bytes, p + 14);
      var compSize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var localOffset = u32(bytes, p + 42);
      var name = decodeUTF8(bytes.subarray(p + 46, p + 46 + nameLen));

      if (u32(bytes, localOffset) !== LOCAL_SIG) { return null; }
      var lNameLen = u16(bytes, localOffset + 26);
      var lExtraLen = u16(bytes, localOffset + 28);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;

      entries.push({
        name: name,
        method: method,
        modTime: modTime,
        modDate: modDate,
        data: bytes.subarray(dataStart, dataStart + compSize)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* Rebuild a STORED zip from entries. */
  function buildZip(entries) {
    var i, total = 0;
    var encodedNames = [];
    for (i = 0; i < entries.length; i++) {
      encodedNames.push(encodeUTF8(entries[i].name));
      total += 30 + encodedNames[i].length + entries[i].data.length;
      total += 46 + encodedNames[i].length;
    }
    total += 22;

    var out = new Uint8Array(total);
    var offset = 0;
    var offsets = [];
    var crcs = [];

    for (i = 0; i < entries.length; i++) {
      var e = entries[i];
      var nameBytes = encodedNames[i];
      var crc = crc32(e.data);
      crcs.push(crc);
      offsets.push(offset);

      putU32(out, offset, LOCAL_SIG);
      putU16(out, offset + 4, 20);      /* version needed */
      putU16(out, offset + 6, 0);       /* flags */
      putU16(out, offset + 8, 0);       /* method: stored */
      putU16(out, offset + 10, e.modTime);
      putU16(out, offset + 12, e.modDate);
      putU32(out, offset + 14, crc);
      putU32(out, offset + 18, e.data.length);
      putU32(out, offset + 22, e.data.length);
      putU16(out, offset + 26, nameBytes.length);
      putU16(out, offset + 28, 0);      /* extra length */
      out.set(nameBytes, offset + 30);
      out.set(e.data, offset + 30 + nameBytes.length);
      offset += 30 + nameBytes.length + e.data.length;
    }

    var cdStart = offset;
    for (i = 0; i < entries.length; i++) {
      var e2 = entries[i];
      var nb = encodedNames[i];
      putU32(out, offset, CENTRAL_SIG);
      putU16(out, offset + 4, 20);      /* version made by */
      putU16(out, offset + 6, 20);      /* version needed */
      putU16(out, offset + 8, 0);       /* flags */
      putU16(out, offset + 10, 0);      /* method: stored */
      putU16(out, offset + 12, e2.modTime);
      putU16(out, offset + 14, e2.modDate);
      putU32(out, offset + 16, crcs[i]);
      putU32(out, offset + 20, e2.data.length);
      putU32(out, offset + 24, e2.data.length);
      putU16(out, offset + 28, nb.length);
      putU16(out, offset + 30, 0);      /* extra */
      putU16(out, offset + 32, 0);      /* comment */
      putU16(out, offset + 34, 0);      /* disk number */
      putU16(out, offset + 36, 0);      /* internal attrs */
      putU32(out, offset + 38, 0);      /* external attrs */
      putU32(out, offset + 42, offsets[i]);
      out.set(nb, offset + 46);
      offset += 46 + nb.length;
    }

    putU32(out, offset, EOCD_SIG);
    putU16(out, offset + 4, 0);
    putU16(out, offset + 6, 0);
    putU16(out, offset + 8, entries.length);
    putU16(out, offset + 10, entries.length);
    putU32(out, offset + 12, offset - cdStart);   /* central directory size */
    putU32(out, offset + 16, cdStart);
    putU16(out, offset + 20, 0);

    return out;
  }

  /*
   * Replace the empty <sheetView> element with one that freezes the given
   * number of header rows. Returns the XML unchanged when the expected shape is
   * not found.
   */
  function freezeXml(xml, rows) {
    if (!rows) { return xml; }
    var pane =
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="' + rows + '" topLeftCell="A' + (rows + 1) + '" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A' + (rows + 1) + '" sqref="A' + (rows + 1) + '"/>' +
      '</sheetView></sheetViews>';
    var re = /<sheetViews>.*?<\/sheetViews>/;
    if (!re.test(xml)) { return xml; }
    return xml.replace(re, pane);
  }

  /* ------------------------------------------------------------- styling */

  /*
   * The workbook's visual language, matching the application palette: dark
   * accent header bars with white text, a quiet zebra band, pill-colored
   * severity cells. All text is Arial (spec: professional font throughout).
   */
  var INK = 'FF1B2733', ACCENT = 'FF1D4E79', MUTED = 'FF5B6B7B';

  var FONTS =
    '<fonts count="10">' +
    '<font><sz val="10"/><color rgb="' + INK + '"/><name val="Arial"/><family val="2"/></font>' +          /* 0 base */
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>' +        /* 1 header */
    '<font><b/><sz val="14"/><color rgb="' + ACCENT + '"/><name val="Arial"/><family val="2"/></font>' +  /* 2 title */
    '<font><b/><sz val="10"/><color rgb="' + ACCENT + '"/><name val="Arial"/><family val="2"/></font>' +  /* 3 section */
    '<font><i/><sz val="9"/><color rgb="' + MUTED + '"/><name val="Arial"/><family val="2"/></font>' +    /* 4 note */
    '<font><b/><sz val="10"/><color rgb="FF8B1A1A"/><name val="Arial"/><family val="2"/></font>' +        /* 5 blocking */
    '<font><b/><sz val="10"/><color rgb="FFB23C17"/><name val="Arial"/><family val="2"/></font>' +        /* 6 error */
    '<font><b/><sz val="10"/><color rgb="FF8A6100"/><name val="Arial"/><family val="2"/></font>' +        /* 7 warning */
    '<font><b/><sz val="10"/><color rgb="FF2E6B4F"/><name val="Arial"/><family val="2"/></font>' +        /* 8 info */
    '<font><u/><sz val="10"/><color rgb="' + ACCENT + '"/><name val="Arial"/><family val="2"/></font>' +  /* 9 link */
    '</fonts>';

  function solidFill(rgb) {
    return '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/></patternFill></fill>';
  }

  /* Appended in this order after the library's own fills. */
  var EXTRA_FILLS = [
    solidFill(ACCENT),      /* +0 header bar */
    solidFill('FFF2F5F8'),  /* +1 zebra band */
    solidFill('FFE8F0F7'),  /* +2 section bar */
    solidFill('FFFBE9E9'),  /* +3 blocking */
    solidFill('FFFDF0E8'),  /* +4 error */
    solidFill('FFFDF7E3'),  /* +5 warning */
    solidFill('FFEAF5EF')   /* +6 info */
  ];

  /*
   * Rewrite styles.xml: swap the default font set for ours, append the fills,
   * and append the named cell formats plus a zebra variant of every format the
   * library already emitted - the variant keeps the original number format, so
   * a banded date cell still renders as a date.
   *
   * Returns { xml, styleIndex, zebraMap } or null when the file does not look
   * like the library's output.
   */
  function patchStylesXml(xml) {
    if (!/<fonts count="\d+">[\s\S]*?<\/fonts>/.test(xml)) { return null; }
    xml = xml.replace(/<fonts count="\d+">[\s\S]*?<\/fonts>/, FONTS);

    var fillsMatch = /<fills count="(\d+)">([\s\S]*?)<\/fills>/.exec(xml);
    if (!fillsMatch) { return null; }
    var fillBase = Number(fillsMatch[1]);
    xml = xml.replace(fillsMatch[0],
      '<fills count="' + (fillBase + EXTRA_FILLS.length) + '">' + fillsMatch[2] + EXTRA_FILLS.join('') + '</fills>');

    var xfsMatch = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (!xfsMatch) { return null; }
    var existing = xfsMatch[2].match(/<xf [^>]*\/>/g) || [];
    var base = existing.length;

    function xf(fontId, fillId, extra) {
      return '<xf numFmtId="0" fontId="' + fontId + '" fillId="' + fillId +
        '" borderId="0" xfId="0" applyFont="1" applyFill="1"' + (extra || '/>');
    }

    var appended = [
      /* header: white on accent, wrapped, vertically centered */
      xf(1, fillBase + 0, ' applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'),
      xf(2, 0),                 /* title */
      xf(3, fillBase + 2),      /* section */
      xf(4, 0),                 /* note */
      xf(5, fillBase + 3),      /* sevBlocking */
      xf(6, fillBase + 4),      /* sevError */
      xf(7, fillBase + 5),      /* sevWarning */
      xf(8, fillBase + 6),      /* sevInfo */
      xf(9, 0),                 /* link */
      /* Right-aligned text values ("Yes", "n/a") in numeric columns, plain
       * and zebra-banded - the builder picks the right one per cell. */
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>',
      '<xf numFmtId="0" fontId="0" fillId="' + (fillBase + 1) + '" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="right"/></xf>',
      /* Section-bar cell aligned right: month labels over numeric columns. */
      xf(3, fillBase + 2, ' applyAlignment="1"><alignment horizontal="right"/></xf>')
    ];
    var styleIndex = {
      header: base, title: base + 1, section: base + 2, note: base + 3,
      sevBlocking: base + 4, sevError: base + 5, sevWarning: base + 6, sevInfo: base + 7,
      link: base + 8, valr: base + 9, valrZ: base + 10, secr: base + 11
    };

    var zebraMap = {};
    for (var i = 0; i < existing.length; i++) {
      var numFmt = /numFmtId="(\d+)"/.exec(existing[i]);
      appended.push('<xf numFmtId="' + (numFmt ? numFmt[1] : '0') +
        '" fontId="0" fillId="' + (fillBase + 1) + '" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>');
      zebraMap[i] = base + appended.length - 1;
    }

    xml = xml.replace(xfsMatch[0],
      '<cellXfs count="' + (base + appended.length) + '">' + xfsMatch[2] + appended.join('') + '</cellXfs>');
    return { xml: xml, styleIndex: styleIndex, zebraMap: zebraMap };
  }

  /*
   * Apply one sheet's plan to its XML: tab color, frozen panes, styled rows,
   * zebra bands, and per-cell overrides (severity and status cells).
   */
  function patchSheetXml(xml, sheetPlan, styles) {
    if (sheetPlan.tab) {
      xml = xml.replace(/(<worksheet[^>]*>)/,
        '$1<sheetPr><tabColor rgb="' + sheetPlan.tab + '"/></sheetPr>');
    }
    if (sheetPlan.freeze) { xml = freezeXml(xml, sheetPlan.freeze); }

    var rowStyles = sheetPlan.rows || {};
    var cellStyles = sheetPlan.cells || {};
    var zebra = {};
    (sheetPlan.zebra || []).forEach(function (n) { zebra[n] = true; });
    var hasCellStyles = false;
    for (var k in cellStyles) { if (Object.prototype.hasOwnProperty.call(cellStyles, k)) { hasCellStyles = true; break; } }
    var hasWork = hasCellStyles || (sheetPlan.zebra || []).length > 0;
    for (var r in rowStyles) { if (Object.prototype.hasOwnProperty.call(rowStyles, r)) { hasWork = true; break; } }
    if (!hasWork) { return xml; }

    return xml.replace(/(<row r="(\d+)"[^>]*>)([\s\S]*?)(<\/row>)/g, function (m, open, rnum, content, close) {
      var n = Number(rnum);
      var named = rowStyles[n];
      if (named && styles.styleIndex[named] !== undefined) {
        content = content.replace(/<c r="([A-Z]+\d+)"( s="\d+")?/g,
          '<c r="$1" s="' + styles.styleIndex[named] + '"');
      } else if (zebra[n]) {
        content = content.replace(/<c r="([A-Z]+\d+)"( s="(\d+)")?/g, function (cm, addr, sAttr, sVal) {
          var mapped = styles.zebraMap[sVal === undefined ? 0 : Number(sVal)];
          return mapped === undefined ? cm : '<c r="' + addr + '" s="' + mapped + '"';
        });
      }
      if (hasCellStyles) {
        content = content.replace(/<c r="([A-Z]+\d+)"( s="\d+")?/g, function (cm, addr) {
          var name = cellStyles[addr];
          if (!name || styles.styleIndex[name] === undefined) { return cm; }
          return '<c r="' + addr + '" s="' + styles.styleIndex[name] + '"';
        });
      }
      return open + content + close;
    });
  }

  var zipPatch = {
    crc32: crc32,
    parseZip: parseZip,
    buildZip: buildZip,
    freezeXml: freezeXml,
    patchStylesXml: patchStylesXml,

    /*
     * bytes       - Uint8Array of the written .xlsx
     * freezeBySheetIndex - { 1: 3, 2: 1, ... } worksheet number -> frozen rows
     */
    applyFreezePanes: function (bytes, freezeBySheetIndex) {
      var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      var entries;
      try {
        entries = parseZip(input);
      } catch (e) {
        return input;
      }
      if (!entries) { return input; }

      var patched = false;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(entry.name);
        if (!m) { continue; }
        var rows = freezeBySheetIndex[Number(m[1])];
        if (!rows) { continue; }
        if (entry.method !== 0) { return input; } /* compressed: leave the file alone */
        var xml = decodeUTF8(entry.data);
        var updated = freezeXml(xml, rows);
        if (updated === xml) { continue; }
        entry.data = encodeUTF8(updated);
        patched = true;
      }
      if (!patched) { return input; }

      /* Every entry must be stored for the rebuild to be byte-correct. */
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].method !== 0) { return input; }
      }
      try {
        return buildZip(entries);
      } catch (e2) {
        return input;
      }
    },

    /*
     * bytes - Uint8Array of the written .xlsx
     * plan  - { sheets: { 1: { tab, freeze, rows, cells, zebra }, ... } }
     *   tab    - 'FFRRGGBB' sheet-tab color
     *   freeze - number of header rows to freeze
     *   rows   - { rowNumber: 'header'|'title'|'section'|'note' }
     *   cells  - { 'A5': 'sevWarning', ... } targeted overrides
     *   zebra  - [rowNumber, ...] banded data rows
     *
     * Every failure path returns the original bytes: an unstyled workbook is
     * always preferable to a corrupted one.
     */
    applyWorkbookPolish: function (bytes, plan) {
      var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      var entries;
      try {
        entries = parseZip(input);
      } catch (e) {
        return input;
      }
      if (!entries) { return input; }
      for (var s = 0; s < entries.length; s++) {
        if (entries[s].method !== 0) { return input; }
      }

      try {
        var styles = null;
        var i;
        for (i = 0; i < entries.length; i++) {
          if (entries[i].name === 'xl/styles.xml') {
            styles = patchStylesXml(decodeUTF8(entries[i].data));
            if (styles) { entries[i].data = encodeUTF8(styles.xml); }
            break;
          }
        }
        if (!styles) { return zipPatch.applyFreezePanes(input, collectFreeze(plan)); }

        for (i = 0; i < entries.length; i++) {
          var m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(entries[i].name);
          if (!m) { continue; }
          var sheetPlan = plan.sheets[Number(m[1])];
          if (!sheetPlan) { continue; }
          entries[i].data = encodeUTF8(patchSheetXml(decodeUTF8(entries[i].data), sheetPlan, styles));
        }
        return buildZip(entries);
      } catch (e2) {
        return input;
      }
    }
  };

  /* Fall back to bare freeze panes when the style sheet is unrecognizable. */
  function collectFreeze(plan) {
    var freeze = {};
    for (var k in plan.sheets) {
      if (Object.prototype.hasOwnProperty.call(plan.sheets, k) && plan.sheets[k].freeze) {
        freeze[k] = plan.sheets[k].freeze;
      }
    }
    return freeze;
  }

  UR.zipPatch = zipPatch;

})(typeof globalThis !== 'undefined' ? globalThis : this);

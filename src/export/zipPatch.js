/*
 * zipPatch.js - post-write patcher that adds frozen header panes to the
 * generated workbook (spec 13).
 *
 * The bundled Apache-2.0 spreadsheet library writes a fixed <sheetViews> block
 * and offers no frozen-pane option, so this module rewrites the worksheet XML
 * after the workbook bytes are produced.
 *
 * It only handles STORED (uncompressed) zip entries, which is what the library
 * emits by default. If it ever encounters a compressed entry it returns the
 * original bytes untouched: a workbook without frozen panes is a small cosmetic
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

  var zipPatch = {
    crc32: crc32,
    parseZip: parseZip,
    buildZip: buildZip,
    freezeXml: freezeXml,

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
    }
  };

  UR.zipPatch = zipPatch;

})(typeof globalThis !== 'undefined' ? globalThis : this);

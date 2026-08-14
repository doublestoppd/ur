/*
 * pdfText.js - extract text lines from simple text-based PDFs.
 *
 * Built for CPSI report-writer output: line-printer layouts drawn with the
 * standard text operators (Tj / ' / " / TJ) in Flate-compressed or plain
 * content streams. This is NOT a general PDF renderer - fonts with custom
 * encodings (CID hex strings without a ToUnicode map) are skipped, images are
 * ignored, and a scanned PDF yields no text at all, which the caller reports
 * honestly.
 *
 * Strings are grouped into visual lines by their text-matrix Y position and
 * ordered by X, so multi-column rows read left to right. Gaps between
 * segments become spaces; CPSI reports draw whole lines as single strings, so
 * column spacing survives verbatim in the common case.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return s;
  }

  /* Find every stream object; inflate the Flate ones, keep plain ones. */
  function contentStreams(bytes) {
    var text = latin1(bytes);
    var out = [];
    var idx = 0;
    for (;;) {
      var streamAt = text.indexOf('stream', idx);
      if (streamAt < 0) { break; }
      var dictStart = text.lastIndexOf('<<', streamAt);
      var dict = dictStart >= 0 ? text.slice(dictStart, streamAt) : '';
      var dataStart = streamAt + 6;
      if (text.charCodeAt(dataStart) === 13) { dataStart++; }
      if (text.charCodeAt(dataStart) === 10) { dataStart++; }
      var end = text.indexOf('endstream', dataStart);
      if (end < 0) { break; }
      var raw = bytes.subarray(dataStart, end);
      /* Trim the EOL that precedes endstream. */
      var trim = raw.length;
      while (trim > 0 && (raw[trim - 1] === 10 || raw[trim - 1] === 13)) { trim--; }
      raw = raw.subarray(0, trim);

      var content = null;
      if (/\/Filter\s*(?:\[\s*)?\/FlateDecode/.test(dict)) {
        try { content = UR.inflate.zlib(raw); } catch (e) { content = null; }
      } else if (dict.indexOf('/Filter') < 0) {
        content = raw;
      }
      if (content) {
        var s = latin1(content);
        if (s.indexOf('Tj') >= 0 || s.indexOf('TJ') >= 0 || s.indexOf('\'') >= 0) { out.push(s); }
      }
      idx = end + 9;
    }
    return out;
  }

  /* Decode a PDF literal string body: escapes and octal (RFC 32000 7.3.4.2). */
  function decodeLiteral(body) {
    var out = '';
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (ch !== '\\') { out += ch; continue; }
      var next = body[++i];
      if (next === 'n') { out += '\n'; }
      else if (next === 'r') { out += '\r'; }
      else if (next === 't') { out += '\t'; }
      else if (next === 'b' || next === 'f') { out += ''; }
      else if (next >= '0' && next <= '7') {
        var oct = next;
        while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') { oct += body[++i]; }
        out += String.fromCharCode(parseInt(oct, 8));
      } else { out += next; } /* \\ \( \) and line continuations */
    }
    return out;
  }

  /*
   * Walk one content stream's tokens, tracking enough text state to place
   * each shown string: Tm sets the matrix (tx, ty), Td/TD translate, T* and
   * the ' / " operators advance a line by the leading (TL).
   */
  function collectStrings(content, sink) {
    var i = 0;
    var n = content.length;
    var stack = [];       /* operand stack: numbers and strings */
    var x = 0, y = 0, leading = 0;
    var lineX = 0, lineY = 0;

    function emit(str) {
      if (str !== '') { sink.push({ x: x, y: y, text: str }); }
    }

    while (i < n) {
      var c = content[i];

      if (c === '(') {
        /* literal string with nesting and escapes */
        var depth = 1;
        var j = i + 1;
        var body = '';
        while (j < n && depth > 0) {
          var sc = content[j];
          if (sc === '\\') { body += sc + (content[j + 1] || ''); j += 2; continue; }
          if (sc === '(') { depth++; }
          if (sc === ')') { depth--; if (!depth) { break; } }
          body += sc;
          j++;
        }
        stack.push({ str: decodeLiteral(body) });
        i = j + 1;
        continue;
      }
      if (c === '<' && content[i + 1] !== '<') {
        /* hex string - typically a CID font without a usable encoding; kept
         * as empty so positioning still advances but no garbage text lands. */
        var close = content.indexOf('>', i);
        stack.push({ str: '' });
        i = close < 0 ? n : close + 1;
        continue;
      }
      if (c === '<' && content[i + 1] === '<') { i += 2; continue; }
      if (c === '[' || c === ']' || c === '{' || c === '}') { i++; continue; }
      if (c === '%') { while (i < n && content[i] !== '\n') { i++; } continue; }
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }
      if (c === '/') {
        var k = i + 1;
        while (k < n && !/[\s\/\[\]()<>{}%]/.test(content[k])) { k++; }
        stack.push({ name: content.slice(i + 1, k) });
        i = k;
        continue;
      }
      if (/[-+.0-9]/.test(c)) {
        var k2 = i;
        while (k2 < n && /[-+.0-9]/.test(content[k2])) { k2++; }
        stack.push({ num: parseFloat(content.slice(i, k2)) });
        i = k2;
        continue;
      }

      /* operator */
      var k3 = i;
      while (k3 < n && /[A-Za-z'"*01]/.test(content[k3])) { k3++; }
      var op = content.slice(i, k3);
      i = k3 === i ? i + 1 : k3;

      function num(offsetFromEnd) {
        var v = stack[stack.length - offsetFromEnd];
        return v && v.num !== undefined ? v.num : 0;
      }
      function str(offsetFromEnd) {
        var v = stack[stack.length - offsetFromEnd];
        return v && v.str !== undefined ? v.str : null;
      }

      if (op === 'Tm') { lineX = x = num(2); lineY = y = num(1); }
      else if (op === 'Td') { lineX = x = lineX + num(2); lineY = y = lineY + num(1); }
      else if (op === 'TD') { leading = -num(1); lineX = x = lineX + num(2); lineY = y = lineY + num(1); }
      else if (op === 'TL') { leading = num(1); }
      else if (op === 'T*') { lineY = y = lineY - leading; x = lineX; }
      else if (op === 'BT') { x = 0; y = 0; lineX = 0; lineY = 0; }
      else if (op === 'Tj') { var s1 = str(1); if (s1 !== null) { emit(s1); } }
      else if (op === "'") { lineY = y = lineY - leading; x = lineX; var s2 = str(1); if (s2 !== null) { emit(s2); } }
      else if (op === '"') { lineY = y = lineY - leading; x = lineX; var s3 = str(1); if (s3 !== null) { emit(s3); } }
      else if (op === 'TJ') {
        /* array of strings and kerning numbers, pushed individually */
        var parts = [];
        while (stack.length && (stack[stack.length - 1].str !== undefined || stack[stack.length - 1].num !== undefined)) {
          var item = stack.pop();
          if (item.str !== undefined) { parts.unshift(item.str); }
        }
        if (parts.length) { emit(parts.join('')); }
        stack.length = 0;
        continue;
      }
      stack.length = 0;
    }
  }

  UR.pdfText = {
    /*
     * bytes -> array of text lines (top of page first). Returns [] when the
     * file has no extractable text (scanned image, exotic encoding).
     */
    extractLines: function (bytes) {
      var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (latin1(input.subarray(0, 5)) !== '%PDF-') { return []; }

      /*
       * Lines are grouped WITHIN each content stream, then streams are
       * concatenated in file order. Merging across streams would interleave
       * text when a page carries more than one stream drawing the same
       * region (annotation overlays, edited PDFs) - each stream's text stays
       * a coherent block instead.
       */
      var lines = [];
      contentStreams(input).forEach(function (content) {
        var pieces = [];
        collectStrings(content, pieces);
        if (!pieces.length) { return; }

        var byY = {};
        var ys = [];
        pieces.forEach(function (p) {
          var key = Math.round(p.y);
          if (!byY[key]) { byY[key] = []; ys.push(key); }
          byY[key].push(p);
        });
        ys.sort(function (a, b) { return b - a; });

        ys.forEach(function (yKey) {
          var segs = byY[yKey].slice().sort(function (a, b) { return a.x - b.x; });
          var line = '';
          segs.forEach(function (seg) {
            if (line && !/\s$/.test(line) && seg.text && !/^\s/.test(seg.text)) { line += ' '; }
            line += seg.text;
          });
          if (line.replace(/\s+/g, '') !== '') { lines.push(line); }
        });
      });
      return lines;
    },

    isPdf: function (bytes) {
      var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return latin1(input.subarray(0, 5)) === '%PDF-';
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

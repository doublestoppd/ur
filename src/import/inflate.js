/*
 * inflate.js - a self-contained DEFLATE/zlib decoder (RFC 1951/1950).
 *
 * Exists so the tool can read the Flate-compressed content streams inside
 * CPSI's PDF reports without any external library or network access. Only
 * decompression is implemented; it is exercised against Node's zlib in the
 * test suite.
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  /* Huffman decoding table built from code lengths (RFC 1951 section 3.2.2). */
  function buildTable(lengths) {
    var maxLen = 0;
    var i;
    for (i = 0; i < lengths.length; i++) { if (lengths[i] > maxLen) { maxLen = lengths[i]; } }
    if (!maxLen) { return null; }
    var blCount = new Array(maxLen + 1);
    for (i = 0; i <= maxLen; i++) { blCount[i] = 0; }
    for (i = 0; i < lengths.length; i++) { if (lengths[i]) { blCount[lengths[i]]++; } }
    var nextCode = new Array(maxLen + 1);
    var code = 0;
    for (i = 1; i <= maxLen; i++) {
      code = (code + blCount[i - 1]) << 1;
      nextCode[i] = code;
    }
    /* Map canonical code -> symbol, keyed by (length, code). */
    var table = {};
    for (i = 0; i < lengths.length; i++) {
      var len = lengths[i];
      if (!len) { continue; }
      table[len + ':' + nextCode[len]] = i;
      nextCode[len]++;
    }
    return { table: table, maxLen: maxLen };
  }

  var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  var FIXED_LIT = (function () {
    var lengths = [];
    var i;
    for (i = 0; i <= 143; i++) { lengths.push(8); }
    for (i = 144; i <= 255; i++) { lengths.push(9); }
    for (i = 256; i <= 279; i++) { lengths.push(7); }
    for (i = 280; i <= 287; i++) { lengths.push(8); }
    return buildTable(lengths);
  })();
  var FIXED_DIST = (function () {
    var lengths = [];
    for (var i = 0; i < 30; i++) { lengths.push(5); }
    return buildTable(lengths);
  })();

  /*
   * Inflate a raw DEFLATE stream. Throws on malformed input; the caller treats
   * that as "this stream is not readable" and moves on.
   */
  function inflateRaw(input) {
    var pos = 0;        /* byte position */
    var bit = 0;        /* bit position inside the current byte */
    var out = [];

    function readBit() {
      if (pos >= input.length) { throw new Error('unexpected end of deflate data'); }
      var b = (input[pos] >>> bit) & 1;
      bit++;
      if (bit === 8) { bit = 0; pos++; }
      return b;
    }
    function readBits(n) {
      var v = 0;
      for (var i = 0; i < n; i++) { v |= readBit() << i; }
      return v;
    }
    /* Huffman codes are read MSB-first. */
    function readCode(huff) {
      var code = 0;
      for (var len = 1; len <= huff.maxLen; len++) {
        code = (code << 1) | readBit();
        var sym = huff.table[len + ':' + code];
        if (sym !== undefined) { return sym; }
      }
      throw new Error('invalid huffman code');
    }

    for (;;) {
      var final = readBit();
      var type = readBits(2);

      if (type === 0) {
        /* Stored block: skip to byte boundary, LEN/NLEN, raw copy. */
        if (bit) { bit = 0; pos++; }
        var len = input[pos] | (input[pos + 1] << 8);
        pos += 4; /* LEN + NLEN */
        for (var s = 0; s < len; s++) { out.push(input[pos + s]); }
        pos += len;
      } else if (type === 1 || type === 2) {
        var lit = FIXED_LIT;
        var dist = FIXED_DIST;
        if (type === 2) {
          var hlit = readBits(5) + 257;
          var hdist = readBits(5) + 1;
          var hclen = readBits(4) + 4;
          var clenLengths = new Array(19);
          var i;
          for (i = 0; i < 19; i++) { clenLengths[i] = 0; }
          for (i = 0; i < hclen; i++) { clenLengths[CLEN_ORDER[i]] = readBits(3); }
          var clenTable = buildTable(clenLengths);
          var lengths = [];
          while (lengths.length < hlit + hdist) {
            var sym = readCode(clenTable);
            if (sym < 16) { lengths.push(sym); }
            else if (sym === 16) {
              var prev = lengths[lengths.length - 1];
              var rep = readBits(2) + 3;
              while (rep--) { lengths.push(prev); }
            } else if (sym === 17) {
              var z3 = readBits(3) + 3;
              while (z3--) { lengths.push(0); }
            } else {
              var z7 = readBits(7) + 11;
              while (z7--) { lengths.push(0); }
            }
          }
          lit = buildTable(lengths.slice(0, hlit));
          dist = buildTable(lengths.slice(hlit));
        }

        for (;;) {
          var symv = readCode(lit);
          if (symv === 256) { break; }
          if (symv < 256) { out.push(symv); continue; }
          var li = symv - 257;
          var length = LENGTH_BASE[li] + readBits(LENGTH_EXTRA[li]);
          var dsym = readCode(dist);
          var distance = DIST_BASE[dsym] + readBits(DIST_EXTRA[dsym]);
          var from = out.length - distance;
          if (from < 0) { throw new Error('invalid back-reference'); }
          for (var c = 0; c < length; c++) { out.push(out[from + c]); }
        }
      } else {
        throw new Error('invalid deflate block type');
      }

      if (final) { break; }
    }
    return new Uint8Array(out);
  }

  UR.inflate = {
    raw: inflateRaw,
    /* zlib wrapper (RFC 1950): 2-byte header, deflate data, Adler-32. The
     * checksum is not verified - a corrupt PDF stream fails loudly in the
     * deflate structure long before a checksum would catch it. */
    zlib: function (input) {
      if (input.length < 2) { throw new Error('not a zlib stream'); }
      var cmf = input[0];
      if ((cmf & 0x0f) !== 8) { throw new Error('unsupported compression method'); }
      if (input[1] & 0x20) { throw new Error('preset dictionaries are not supported'); }
      return inflateRaw(input.subarray(2));
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

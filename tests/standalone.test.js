/*
 * The single-file distribution (build/standalone.js).
 *
 * Guarantees: everything is inlined (no file or network reference survives),
 * the comment-stripping pass can never break a source file, and the build is
 * deterministic so an unchanged rebuild never dirties the artifact.
 */
'use strict';

var f = require('./framework');
var describe = f.describe, test = f.test, assert = f.assert;
var fs = require('fs');
var path = require('path');
var standalone = require('../build/standalone');

var ROOT = path.join(__dirname, '..');

describe('standalone single-file build', function () {

  var result = standalone.build();
  var html = fs.readFileSync(standalone.OUT_FILE, 'utf8');

  test('every script and the stylesheet are inlined', function () {
    assert.ok(result.scripts >= 25, result.scripts + ' scripts inlined');
    assert.equal(html.indexOf('<script src='), -1, 'no script file reference survives');
    assert.equal(html.indexOf('<link'), -1, 'no stylesheet reference survives');
    ['/* vendor/xlsx.full.min.js */', '/* src/ui/app.js */', '/* src/quality/attention.js */',
     'hospitalInsuranceCodes', '<style>'].forEach(function (marker) {
      assert.ok(html.indexOf(marker) >= 0, 'contains ' + marker);
    });
  });

  test('no attribute fetches anything over the network', function () {
    /* URLs inside JS strings (OOXML namespaces) are data, not fetches;
     * an src= or href= attribute pointing at http would be a fetch. */
    assert.notOk(/(src|href)\s*=\s*"https?:/i.test(html));
  });

  test('comment stripping never breaks a source file', function () {
    var page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    var sources = [];
    page.replace(/<script src="(src\/[^"]+)"><\/script>/g, function (m, src) {
      sources.push(src);
      return m;
    });
    assert.ok(sources.length >= 25, 'found the source list');
    sources.forEach(function (src) {
      var js = fs.readFileSync(path.join(ROOT, src), 'utf8');
      var stripped = standalone.stripCommentLines(js);
      assert.ok(stripped.length < js.length, src + ' shrank');
      /* Throws on a syntax error, which is exactly the point. */
      /* eslint-disable no-new-func */
      new Function(stripped);
    });
  });

  test('a closing script tag inside JS cannot end the inline block early', function () {
    assert.equal(standalone.scriptSafe('var a = "</script>";'), 'var a = "<\\/script>";');
  });

  test('the build is deterministic', function () {
    var first = fs.readFileSync(standalone.OUT_FILE, 'utf8');
    standalone.build();
    var second = fs.readFileSync(standalone.OUT_FILE, 'utf8');
    assert.ok(first === second, 'same inputs, same bytes - a no-change rebuild never dirties the file');
  });
});

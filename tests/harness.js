/*
 * harness.js - loads the application exactly as the browser does.
 *
 * The script list is parsed out of index.html rather than duplicated here, so a
 * source file that is added to the project but forgotten in the page - or
 * loaded in the wrong dependency order - fails the test suite instead of
 * failing on a hospital workstation.
 *
 * src/ui/* is skipped because it needs a DOM.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');

function scriptList() {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var re = /<script src="([^"]+)"><\/script>/g;
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null) { out.push(m[1]); }
  return out;
}

function load(options) {
  var opts = options || {};
  var all = scriptList();
  var files = all.filter(function (f) {
    if (f.indexOf('src/ui/') === 0) { return false; }
    if (opts.skipVendor && f.indexOf('vendor/') === 0) { return false; }
    return true;
  });

  var sandbox = {
    console: console,
    Buffer: Buffer,
    process: process,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);

  files.forEach(function (f) {
    var full = path.join(ROOT, f);
    if (!fs.existsSync(full)) {
      throw new Error('index.html references a missing file: ' + f);
    }
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: f });
  });

  return { UR: sandbox.UR, XLSX: sandbox.XLSX, files: files, allScripts: all, sandbox: sandbox };
}

module.exports = { load: load, scriptList: scriptList, ROOT: ROOT };

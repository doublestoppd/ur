/*
 * run.js - entry point for the unit test suite.
 *
 *   node tests/run.js
 *
 * Discovers every *.test.js file in this directory, runs it, and exits non-zero
 * on the first failure so the suite can gate a change to any calculation rule
 * (spec 15.3).
 */
'use strict';

var fs = require('fs');
var path = require('path');
var framework = require('./framework');

var files = fs.readdirSync(__dirname)
  .filter(function (f) { return /\.test\.js$/.test(f); })
  .sort();

if (!files.length) {
  process.stdout.write('No test files found.\n');
  process.exitCode = 1;
} else {
  files.forEach(function (f) { require(path.join(__dirname, f)); });
  framework.run();
}

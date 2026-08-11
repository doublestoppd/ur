/*
 * framework.js - a dependency-free test runner.
 *
 * The distribution must work without npm on the target workstation, so the test
 * tooling stays inside the repository too: `node tests/run.js` and nothing else.
 */
'use strict';

var suites = [];
var current = null;

function describe(name, fn) {
  current = { name: name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

function test(name, fn) {
  if (!current) {
    current = { name: '(ungrouped)', tests: [] };
    suites.push(current);
  }
  current.tests.push({ name: name, fn: fn });
}

function fail(message) {
  var err = new Error(message);
  err.isAssertion = true;
  throw err;
}

function show(v) {
  if (v instanceof Date) { return v.toISOString(); }
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}

var assert = {
  ok: function (cond, message) {
    if (!cond) { fail(message || 'Expected a truthy value.'); }
  },
  notOk: function (cond, message) {
    if (cond) { fail(message || 'Expected a falsy value.'); }
  },
  equal: function (actual, expected, message) {
    if (actual !== expected) {
      fail((message || 'Values differ') + '\n    expected: ' + show(expected) + '\n    actual:   ' + show(actual));
    }
  },
  notEqual: function (actual, expected, message) {
    if (actual === expected) { fail((message || 'Expected values to differ') + ' (' + show(actual) + ')'); }
  },
  close: function (actual, expected, tolerance, message) {
    var tol = tolerance === undefined ? 1e-9 : tolerance;
    if (actual === null || actual === undefined || Math.abs(actual - expected) > tol) {
      fail((message || 'Values differ') + '\n    expected: ' + show(expected) + ' (+/- ' + tol + ')\n    actual:   ' + show(actual));
    }
  },
  deepEqual: function (actual, expected, message) {
    var a = JSON.stringify(actual);
    var b = JSON.stringify(expected);
    if (a !== b) {
      fail((message || 'Structures differ') + '\n    expected: ' + b + '\n    actual:   ' + a);
    }
  },
  includes: function (haystack, needle, message) {
    if (String(haystack).indexOf(needle) < 0) {
      fail((message || 'Expected text to contain "' + needle + '"') + '\n    actual: ' + show(haystack));
    }
  },
  throws: function (fn, message) {
    var threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) { fail(message || 'Expected the call to throw.'); }
  }
};

function run() {
  var passed = 0;
  var failures = [];
  var started = Date.now();

  suites.forEach(function (suite) {
    process.stdout.write('\n' + suite.name + '\n');
    suite.tests.forEach(function (t) {
      try {
        t.fn();
        passed++;
        process.stdout.write('  PASS  ' + t.name + '\n');
      } catch (e) {
        failures.push({ suite: suite.name, test: t.name, error: e });
        process.stdout.write('  FAIL  ' + t.name + '\n');
        var text = e && e.isAssertion ? e.message : (e && e.stack ? e.stack : String(e));
        process.stdout.write('        ' + String(text).split('\n').join('\n        ') + '\n');
      }
    });
  });

  var total = passed + failures.length;
  process.stdout.write('\n' + passed + '/' + total + ' passed in ' + (Date.now() - started) + 'ms\n');
  if (failures.length) {
    process.stdout.write(failures.length + ' failing\n');
    process.exitCode = 1;
  }
  return failures.length === 0;
}

module.exports = { describe: describe, test: test, assert: assert, run: run };

/*
 * Runs every *.test.js in this directory. Run: node tests/run.js
 *
 * There is no package.json and no `npm test` — this repo is static files on
 * GitHub Pages, and a dependency tree to run four scripts would be the tail
 * wagging the dog. This is the one-command version.
 *
 * Each suite is a standalone script that exits non-zero on failure, so they can
 * still be run individually while working on one of them.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const suites = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

const failed = [];

for (const suite of suites) {
    console.log(`\n\x1b[1m${suite}\x1b[0m`);
    const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (result.status !== 0) failed.push(suite);
}

console.log();
if (failed.length) {
    console.log(`\x1b[31m${failed.length} of ${suites.length} suites failed: ${failed.join(', ')}\x1b[0m`);
    process.exit(1);
}
console.log(`\x1b[32mall ${suites.length} suites passed\x1b[0m`);

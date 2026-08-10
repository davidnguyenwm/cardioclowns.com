/*
 * Launch-day readiness. Run: node tests/launch-readiness.test.js
 *
 * WHY THIS EXISTS
 *
 * Going live is one flag — `LAUNCHED` in appstore.js — and it is meant to stay
 * one flag. Everything that used to be a second launch-day edit now happens at
 * runtime from that flag, so what is left is two API tokens:
 *
 *   CF_BEACON_TOKEN   missing -> the website measures nothing on the one day
 *                     traffic actually arrives. Obtainable today; therefore a
 *                     hard failure if the flag flips without it.
 *   PROVIDER_TOKEN    missing -> links work, every install reports as an
 *                     anonymous "Web Referrer", and the history cannot be
 *                     backfilled.
 *
 * The second one is deliberately NOT a launch blocker, which is the opposite of
 * where this file started. App Store Connect answers "This app is currently
 * unavailable for Analytics" until the app has been released, and the campaign
 * link that carries `pt` is generated inside App Analytics — so the token does
 * not exist until after the thing it is supposed to gate. Blocking on it would
 * have failed the build on launch morning, over a value only launching can
 * produce. It is reported as "now" once live instead, every day it stays open
 * costing attribution that never comes back.
 *
 * Neither token breaks a download, which is why neither announces itself.
 *
 * This file is quiet and green today, listing what is still pending, and turns
 * into a hard failure the moment LAUNCHED flips with anything unfinished that
 * could have been finished. Run it right after flipping and before deploying.
 *
 * Dependency-free on purpose — this repo is static files on GitHub Pages and
 * has no package.json. Keep it that way.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
let checks = 0;

function check(name, problems) {
    checks++;
    if (problems.length === 0) {
        console.log(`  ok    ${name}`);
        return;
    }
    failures++;
    console.log(`  FAIL  ${name}`);
    for (const p of problems) console.log(`          ${p}`);
}

const appstore = fs.readFileSync(path.join(ROOT, 'appstore.js'), 'utf8');
const analytics = fs.readFileSync(path.join(ROOT, 'analytics.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------- read the launch switches out of the source ---------- */

function declared(src, name, file) {
    const m = src.match(new RegExp('var ' + name + " = '([^']*)';"));
    if (m) return m[1];
    // A rename is not a pass. If this file can't find a switch, it cannot
    // report on it, and staying silent would be the worst of both worlds.
    console.error(`Could not find \`var ${name}\` in ${file} — the launch gate can no longer read it.`);
    process.exit(1);
}

const launchedMatch = appstore.match(/var LAUNCHED = (true|false);/);
if (!launchedMatch) {
    console.error('Could not find `var LAUNCHED` in appstore.js — the launch gate can no longer read it.');
    process.exit(1);
}
const LAUNCHED = launchedMatch[1] === 'true';
const APP_STORE_ID = declared(appstore, 'APP_STORE_ID', 'appstore.js');
const PROVIDER_TOKEN = declared(appstore, 'PROVIDER_TOKEN', 'appstore.js');
const CF_BEACON_TOKEN = declared(analytics, 'TOKEN', 'analytics.js');

/* ---------- the automation that makes the flip sufficient ---------- */

// Comments stripped first: the note beside each button mentions
// data-cc-campaign, and counting those would find CTAs that don't exist. Same
// blind spot the MARKETS duplicate-key check ran into.
const indexNoComments = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
const ctaCount = [...indexNoComments.matchAll(/\sdata-cc-campaign="/g)].length;
const wiredAtRuntime = /CCStore\.wireLinks\(/.test(indexHtml) && /function activate\(/.test(appstore);

/* ---------- the readiness table ---------- */

// `blocksLaunch: false` means "cannot be done yet", not "matters less".
const items = [
    {
        label: 'App Store id is a real number',
        ok: /^[0-9]+$/.test(APP_STORE_ID),
        blocksLaunch: true,
        pending: `APP_STORE_ID is '${APP_STORE_ID}'`,
        fix: 'App Store Connect → App Information → Apple ID'
    },
    {
        label: 'Cloudflare beacon token is set, so the site is measured',
        ok: /^[0-9a-f]{32}$/i.test(CF_BEACON_TOKEN),
        blocksLaunch: true,
        pending: `CF_BEACON_TOKEN is '${CF_BEACON_TOKEN}' — the website counts nothing`,
        fix: 'Cloudflare → Web Analytics → add cardioclowns.com → copy the token'
    },
    {
        label: 'the download CTAs activate themselves from the flag',
        ok: ctaCount > 0 && wiredAtRuntime,
        blocksLaunch: true,
        pending: ctaCount === 0
            ? 'no data-cc-campaign elements found in index.html at all'
            : 'index.html no longer calls CCStore.wireLinks(), or appstore.js lost activate() — the CTAs would stay "Coming soon" spans after the flip',
        fix: 'restore the runtime activation; tests/appstore.test.js covers what it has to do'
    },
    {
        // Deliberately not a launch blocker, and it took a screenshot of App
        // Store Connect to learn why: App Analytics answers "This app is
        // currently unavailable for Analytics" until the app has actually been
        // released, and the campaign-link generator that mints `pt` lives
        // inside App Analytics. The token does not exist before launch. Making
        // it a blocker would mean the launch flag could never be flipped —
        // failing the build on launch morning for something only launching can
        // fix.
        label: 'provider token is set, so campaigns report',
        ok: /^[0-9]+$/.test(PROVIDER_TOKEN),
        blocksLaunch: false,
        pending: `PROVIDER_TOKEN is '${PROVIDER_TOKEN}' — installs report as anonymous Web Referrer until it is set, and that history never backfills`,
        fix: 'once live: App Store Connect → Analytics → Acquisition → Campaigns → create a link, and copy the pt= value out of it'
    }
];

console.log(`launch flag: LAUNCHED = ${LAUNCHED}\n`);

const blocking = items.filter((item) => item.blocksLaunch);
const afterLaunch = items.filter((item) => !item.blocksLaunch);

if (LAUNCHED) {
    // Live. Anything that could have been done beforehand is now a defect on a
    // page that is serving.
    check('the site is live and fully instrumented', blocking
        .filter((item) => !item.ok)
        .map((item) => `${item.pending}\n            fix: ${item.fix}`));

    // Not failures — these unlock *because* the flag flipped. Loud, because
    // every day they stay open is attribution that cannot be recovered.
    for (const item of afterLaunch.filter((i) => !i.ok)) {
        console.log(`  now   ${item.label}`);
        console.log(`          ${item.pending}`);
        console.log(`          fix: ${item.fix}`);
    }
} else {
    // Pre-launch. These are not failures, they are the checklist — but the
    // checklist has to be visible, or it is just a placeholder nobody reads.
    console.log('  --    pre-launch: the checks below are reported, not enforced.\n');
    for (const item of items) {
        if (item.ok) {
            console.log(`  ok    ${item.label}`);
        } else {
            console.log(`  ${item.blocksLaunch ? 'todo' : 'wait'}  ${item.label}`);
            console.log(`          ${item.pending}`);
            console.log(`          fix: ${item.fix}`);
        }
    }
    console.log();
    checks++;
    console.log(`  ok    launch gate is readable and will enforce ${blocking.length} items when LAUNCHED flips`);
    console.log(`        (${afterLaunch.length} more can only be done once the app is live — shown as "wait")`);
}

/* ---------- always enforced, launched or not ---------- */

// A hand-written App Store link bypasses appstore.js entirely: no pt, no ct, no
// campaign, and no warning. It is also the most natural thing in the world to
// paste in while adding a button.
check('no page hand-writes an App Store link', (() => {
    const problems = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'tests') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(path.join(dir, entry.name), rel); continue; }
            if (!entry.name.endsWith('.html')) continue;
            const html = fs.readFileSync(path.join(dir, entry.name), 'utf8');
            if (/https:\/\/apps\.apple\.com/.test(html)) {
                problems.push(`${rel} hard-codes an apps.apple.com link — it would ship with no campaign attached`);
            }
        }
    };
    walk(ROOT, '');
    return problems;
})());

/* ---------- summary ---------- */

console.log();
if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed`);
    process.exit(1);
}
console.log(LAUNCHED
    ? `all ${checks} checks passed — cleared to deploy`
    : `all ${checks} checks passed — not launched yet, see the todo list above`);

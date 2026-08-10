/*
 * Launch-day readiness. Run: node tests/launch-readiness.test.js
 *
 * WHY THIS EXISTS
 *
 * Going live is one flag — `LAUNCHED` in appstore.js — but three other things
 * have to be true at the same moment, and none of them announces itself when
 * it isn't:
 *
 *   PROVIDER_TOKEN    missing -> links work, every install reports as an
 *                     anonymous "Web Referrer", and the history cannot be
 *                     backfilled. You find out weeks later, permanently.
 *   CF_BEACON_TOKEN   missing -> the website measures nothing on the one day
 *                     traffic actually arrives.
 *   the CTA elements  the download buttons are <span>s until someone swaps
 *                     them for <a>s. appstore.js deliberately skips non-anchors,
 *                     so flipping LAUNCHED alone ships a homepage that still
 *                     says "Coming soon" — with a working Smart App Banner
 *                     above it, which is what makes it easy to miss.
 *
 * So this file is quiet and green today, listing what is still pending, and
 * turns into a hard failure the moment LAUNCHED flips with any of the above
 * unfinished. Run it right after flipping the flag and before deploying.
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

/* ---------- the CTA elements ---------- */

// Comments stripped first: the TODO next to each button mentions
// data-cc-campaign, and counting those would report two anchors that don't
// exist. Same blind spot the MARKETS duplicate-key check ran into.
const indexNoComments = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
const ctaTags = [...indexNoComments.matchAll(/<(\w+)[^>]*\sdata-cc-campaign="/g)].map((m) => m[1].toLowerCase());
const ctaSpans = ctaTags.filter((t) => t !== 'a').length;

/* ---------- the readiness table ---------- */

const items = [
    {
        label: 'App Store id is a real number',
        ok: /^[0-9]+$/.test(APP_STORE_ID),
        pending: `APP_STORE_ID is '${APP_STORE_ID}'`,
        fix: 'App Store Connect → App Information → Apple ID'
    },
    {
        label: 'provider token is set, so campaigns report',
        ok: /^[0-9]+$/.test(PROVIDER_TOKEN),
        pending: `PROVIDER_TOKEN is '${PROVIDER_TOKEN}' — installs will report as anonymous Web Referrer, not backfillable`,
        fix: 'App Store Connect → Users and Access → the numeric provider/campaign token'
    },
    {
        label: 'Cloudflare beacon token is set, so the site is measured',
        ok: /^[0-9a-f]{32}$/i.test(CF_BEACON_TOKEN),
        pending: `CF_BEACON_TOKEN is '${CF_BEACON_TOKEN}' — the website counts nothing`,
        fix: 'Cloudflare → Web Analytics → add cardioclowns.com → copy the token'
    },
    {
        label: 'download CTAs are anchors, not "Coming soon" spans',
        ok: ctaTags.length > 0 && ctaSpans === 0,
        pending: ctaTags.length === 0
            ? 'no data-cc-campaign elements found in index.html at all'
            : `${ctaSpans} of ${ctaTags.length} CTA elements are still <${[...new Set(ctaTags.filter((t) => t !== 'a'))].join('>/<')}> — appstore.js skips non-anchors, so they stay "Coming soon"`,
        fix: 'swap each <span class="cc-cta cc-cta-soon"> for <a class="cc-cta">, keeping data-cc-campaign'
    }
];

console.log(`launch flag: LAUNCHED = ${LAUNCHED}\n`);

if (LAUNCHED) {
    // Live. Every one of these is now a defect on a page that is serving.
    check('the site is live and fully instrumented', items
        .filter((item) => !item.ok)
        .map((item) => `${item.pending}\n            fix: ${item.fix}`));
} else {
    // Pre-launch. These are not failures, they are the checklist — but the
    // checklist has to be visible, or it is just a placeholder nobody reads.
    console.log('  --    pre-launch: the checks below are reported, not enforced.');
    console.log('        They become hard failures the moment LAUNCHED flips to true.\n');
    for (const item of items) {
        if (item.ok) {
            console.log(`  ok    ${item.label}`);
        } else {
            console.log(`  todo  ${item.label}`);
            console.log(`          ${item.pending}`);
            console.log(`          fix: ${item.fix}`);
        }
    }
    console.log();
    checks++;
    console.log(`  ok    launch gate is readable and will enforce ${items.length} items when LAUNCHED flips`);
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

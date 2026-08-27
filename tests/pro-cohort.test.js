/*
 * Post-launch Pro cohort tests. Run: node tests/pro-cohort.test.js
 *
 * WHY THIS EXISTS
 *
 * The Money tab of /stats now answers "how many real people have paid us?" —
 * and it is the one number on the page that is wrong by default. Cardio Clowns
 * spent months in TestFlight buying Pro against the StoreKit sandbox, where a
 * subscription is free and can be re-bought every few minutes. Those devices
 * emit exactly the events a customer emits. Count them and the tab reports a
 * business that does not exist; miscount them in the other direction and a
 * genuine first sale is invisible on the day it matters most.
 *
 * `proCohort` draws the line, and it draws it per DEVICE by first Pro signal —
 * not per event by date. Everything below pins that distinction:
 *
 *   - a tester who reinstalls after launch emits a fresh `pro_started`, which
 *     a date filter would file as a new customer. Its earlier `is_pro=true`
 *     events are the only thing that says otherwise, and they are ordinary
 *     events with no purchase semantics at all — nothing about the code makes
 *     it obvious they are load-bearing.
 *   - `is_pro` is the only signal that can see a subscription which started
 *     before the window opened, so dropping it silently reclassifies every
 *     long-standing tester as a launch-day sale.
 *   - debug-menu paywall previews log a real `purchase_succeeded`.
 *
 * Every one of those failures produces a plausible-looking number, which is
 * the kind that gets believed.
 *
 * Dependency-free on purpose: this repo is static files on GitHub Pages and
 * has no package.json. Keep it that way.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const eq = (name, actual, expected) => check(
    name,
    actual === expected ? [] : [`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`]
);

/* --------------------------------------------------------------------------
   Loading the code under test.

   The page script boots itself on load, so the pieces the cohort reader needs
   are sliced out by their own delimiters and run alone. Each slice fails loudly
   here if its markers ever move, rather than quietly testing nothing.
   -------------------------------------------------------------------------- */

const PAGE = fs.readFileSync(path.join(ROOT, 'stats', 'index.html'), 'utf8');

function slice(what, start, end) {
    const from = PAGE.indexOf(start);
    const to = PAGE.indexOf(end, from + 1);
    if (from < 0 || to < 0 || to <= from) {
        console.log(`  FAIL  locate ${what} in stats/index.html`);
        console.log(`          start ${from < 0 ? 'missing' : 'at ' + from}, end ${to < 0 ? 'missing' : 'at ' + to}`);
        process.exit(1);
    }
    return PAGE.slice(from, to);
}

const SECTION = [
    slice('the day helpers', 'const dayKey = (ms) => {', 'const ago = (ms) => {'),
    slice('the Pro tag helpers', 'const isPro = (e) =>', '/** Distinct-value counter'),
    slice('fillDays', 'function fillDays(days) {', '/** `AnalyticsManager.fetchEngagement`'),
    slice('the cohort reader', '/**\n * The customers, told apart from ourselves.', '/** `AnalyticsManager.fetchPermissionStats`'),
    // `const` bindings do not land on the sandbox global by themselves.
    'Object.assign(globalThis, { LAUNCH_TS, isPro, dayKey });',
].join('\n');

const sandbox = { console };
vm.createContext(sandbox);
new vm.Script(SECTION).runInContext(sandbox);
const { proCohort, LAUNCH_TS } = sandbox;

/* --------------------------------------------------------------------------
   Fixtures. One helper per event shape we care about, all defaulting to
   "ordinary event from a Free device" so each test states only its difference.
   -------------------------------------------------------------------------- */

const DAY = 86400000;
const AFTER = LAUNCH_TS + 2 * 3600000;      // two hours into launch day
const BEFORE = LAUNCH_TS - 30 * DAY;        // a month of TestFlight before it

function ev(device, event, ts, params) {
    return {
        deviceID: device,
        event,
        ts,
        platform: 'iOS',
        sessionID: device + '-s',
        groupCode: 'AAAAAA',
        appVersion: '1.0 (68)',
        params: Object.assign({ is_pro: 'false' }, params || {}),
    };
}

const opened = (device, ts, pro) => ev(device, 'screen_view', ts, { screen: 'home', is_pro: pro ? 'true' : 'false', country: 'DE' });
const bought = (device, ts, extra) => ev(device, 'purchase_succeeded', ts, Object.assign({
    source: 'history', plan: 'yearly', price: '€19.99', free_tenure_days: '3.0', exposures_before_purchase: '2', is_pro: 'false',
}, extra || {}));
const started = (device, ts, trigger, plan) => ev(device, 'pro_started', ts, { trigger, plan: plan || 'yearly', is_pro: 'true' });

/* ----------------------------- The tests ----------------------------- */

console.log('\n  the line between customers and ourselves');

{
    const events = [
        opened('buyer', AFTER - 60000),
        bought('buyer', AFTER),
        started('buyer', AFTER + 1000, 'purchase'),
    ];
    const c = proCohort(events, 90);
    eq('a launch-day buyer is one new Pro device', c.total, 1);
    eq('  …counted as paid', c.paid, 1);
    eq('  …and not as a tester', c.testers, 0);
    eq('  …with the plan it bought', c.yearly, 1);
    eq('  …and the price it paid', c.devices[0].price, '€19.99');
    eq('  …attributed to the gate that showed it', c.sources[0].key, 'history');
}

{
    // The failure this file exists for: a sandbox tester reinstalls after
    // launch, StoreKit hands the entitlement back, and `pro_started` fires
    // with a launch-day timestamp. Filtering by event date calls that a sale.
    const events = [
        opened('tester', BEFORE, true),
        bought('tester', BEFORE + DAY, { price: '€0.00' }),
        opened('tester', AFTER + DAY, true),
        started('tester', AFTER + DAY, 'restore'),
    ];
    const c = proCohort(events, 90);
    eq('a tester who reinstalls after launch is not a new customer', c.total, 0);
    eq('  …it is counted as a pre-launch tester', c.testers, 1);
    eq('  …and did not buy again', c.testersWhoBought, 0);
}

{
    // The same tester, but this time it really does subscribe with money after
    // launch. It stays out of the cohort — its Pro life did not start here —
    // but the purchase is reported rather than lost.
    const events = [
        opened('tester', BEFORE, true),
        opened('tester', AFTER, true),
        bought('tester', AFTER + 3600000),
    ];
    const c = proCohort(events, 90);
    eq('a tester who buys for real stays out of the cohort', c.total, 0);
    eq('  …but their purchase is still surfaced', c.testersWhoBought, 1);
}

{
    // `is_pro` is the only evidence of a subscription that began before the
    // window. Ignore it and this device becomes a launch-day sale.
    const events = [
        opened('old', BEFORE, true),
        ev('old', 'subscription_renewed', AFTER, { plan: 'yearly', is_pro: 'true' }),
    ];
    const c = proCohort(events, 90);
    eq('a renewal of a pre-launch subscription is not a new device', c.total, 0);
    eq('  …it is a tester', c.testers, 1);
}

{
    const events = [
        opened('dbg', AFTER - 60000),
        bought('dbg', AFTER, { source: 'debug' }),
    ];
    const c = proCohort(events, 90);
    eq('a debug-menu preview purchase is not a customer', c.total, 0);
    eq('  …and not a tester either, since it never held Pro', c.testers, 0);
}

console.log('\n  how each device arrived');

{
    const events = [
        started('code', AFTER, 'launch', 'yearly'),          // offer code redeemed in the App Store
        started('second', AFTER, 'restore', 'monthly'),      // same person, second device
        opened('payer', AFTER), bought('payer', AFTER + 1000, { plan: 'monthly', price: '€2.99' }),
    ];
    const c = proCohort(events, 90);
    eq('three devices, three routes', c.total, 3);
    eq('  bought here', c.paid, 1);
    eq('  restored', c.restored, 1);
    eq('  entitled elsewhere', c.entitled, 1);
    eq('  plan split follows the device, not the purchase alone', c.monthly, 2);
    check('a redeemed code reads as entitled elsewhere, not as a sale',
        c.devices.some((d) => d.id === 'code' && d.routeLabel === 'Entitled elsewhere' && d.paid === false)
            ? [] : ['route was ' + JSON.stringify(c.devices.filter((d) => d.id === 'code').map((d) => d.routeLabel))]);
}

{
    const events = [
        opened('churn', AFTER), bought('churn', AFTER + 1000), started('churn', AFTER + 2000, 'purchase'),
        ev('churn', 'pro_ended', AFTER + 10 * DAY, { pro_tenure_days: '10.0', trigger: 'launch', is_pro: 'false' }),
    ];
    const c = proCohort(events, 90);
    eq('a device that lapsed is still in the cohort', c.total, 1);
    eq('  …counted as ended', c.ended, 1);
    eq('  …and not as still Pro', c.stillPro, 0);
}

console.log('\n  the window');

{
    const events = [opened('a', AFTER), bought('a', AFTER)];
    const wide = proCohort(events, 90);
    check('a window reaching launch day says so', wide.coversLaunch ? [] : ['coversLaunch was false for 90 days']);

    // Seven days no longer reaches 26 Aug 2026. The panel has to say the count
    // starts later, because a truncated cohort reads exactly like lost sales.
    const narrow = proCohort(events, 7);
    const stillReaches = Date.now() - 7 * DAY <= LAUNCH_TS;
    check('a window that stops after launch day admits it',
        narrow.coversLaunch === stillReaches ? [] : [`coversLaunch was ${narrow.coversLaunch}, expected ${stillReaches}`]);
}

{
    const c = proCohort([], 30);
    eq('no events is an empty cohort, not a crash', c.total, 0);
    eq('  …with an empty device list', c.devices.length, 0);
    check('  …and a per-day series that is all zeros',
        c.series.went.every((n) => n === 0) ? [] : ['series had non-zero points: ' + JSON.stringify(c.series.went)]);
    check('  …one label per day', c.series.labels.length === c.series.went.length ? []
        : [`${c.series.labels.length} labels for ${c.series.went.length} points`]);
}

{
    // The series must start at launch day, never before it: a chart that opens
    // in the TestFlight era invites reading sandbox quiet as a slow launch.
    const c = proCohort([], 365);
    const days = Math.floor((Date.now() - LAUNCH_TS) / DAY) + 1;
    check('the per-day series starts at launch day even in a long window',
        Math.abs(c.series.went.length - days) <= 1 ? []
            : [`${c.series.went.length} points for ${days} days since launch`]);
}

console.log('\n  the launch moment itself');

{
    const iso = new Date(LAUNCH_TS).toISOString();
    eq('LAUNCH_TS is 26 Aug 2026 06:40 UTC, when 1.0 went live', iso, '2026-08-26T06:40:00.000Z');
}

{
    const events = [opened('edge', LAUNCH_TS), started('edge', LAUNCH_TS, 'purchase')];
    eq('a device Pro at the exact launch instant counts as new', proCohort(events, 90).total, 1);
    const before = [opened('edge', LAUNCH_TS - 1, true)];
    eq('one millisecond earlier is a tester', proCohort(before, 90).testers, 1);
}

console.log();
if (failures) {
    console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
    process.exit(1);
}
console.log(`\x1b[32mall ${checks} checks passed\x1b[0m`);

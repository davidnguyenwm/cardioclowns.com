/*
 * Featuring-detection tests. Run: node tests/featuring.test.js
 *
 * WHY THIS EXISTS
 *
 * The Featuring tab of /stats answers one question — "is an App Store
 * somewhere pushing us right now?" — and it gets exactly one chance to answer
 * it correctly, on launch day, while nobody has the attention to spare for
 * debugging a dashboard. Both of its detectors fail silently:
 *
 *   - The install-lift table compares each country's SHARE of new installs
 *     against its share before the window. Compare raw counts instead and
 *     launch day flags all forty markets at once, which is the same as
 *     flagging none of them. That distinction is one division, it has no
 *     visible symptom, and it is the entire value of the panel.
 *
 *   - The storefront scan reads Apple's per-country chart feed and matches our
 *     app inside it. A wrong bundle id, or a feed shape we did not expect,
 *     reports "not charting anywhere" — which reads exactly like the true
 *     negative it is impossible to distinguish it from.
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

/* --------------------------------------------------------------------------
   Loading the code under test.

   The whole page script cannot simply be evaluated: it reaches for #tip, binds
   document listeners and boots itself. So the featuring section is sliced out
   by its own delimiters and run alone. If those delimiters ever move the slice
   fails loudly here rather than quietly testing nothing.
   -------------------------------------------------------------------------- */

const PAGE = fs.readFileSync(path.join(ROOT, 'stats', 'index.html'), 'utf8');

const START = 'function featuring(events, recentHours) {';
const END = '/* ====================================================================\n   5. Chart components';

const from = PAGE.indexOf(START);
const to = PAGE.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
    console.log('  FAIL  locate the featuring section in stats/index.html');
    console.log(`          start marker ${from < 0 ? 'missing' : 'at ' + from}, end marker ${to < 0 ? 'missing' : 'at ' + to}`);
    process.exit(1);
}

// Function declarations land on the sandbox global by themselves; `const`
// bindings do not, so the constants under test are handed over explicitly.
const SECTION = PAGE.slice(from, to)
    + '\n;Object.assign(globalThis, { APP_STORE_ID, BUNDLE_ID, GENRE_HEALTH, STOREFRONTS });\n';

/** Fresh sandbox per test, so one test's fetch stub can't leak into the next. */
function load(fetchImpl) {
    const store = new Map();
    const sandbox = {
        console,
        fetch: fetchImpl || (() => Promise.reject(new Error('no fetch stub'))),
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
        },
    };
    vm.createContext(sandbox);
    new vm.Script(SECTION).runInContext(sandbox);
    return sandbox;
}

/**
 * The panel itself, with the real helpers and chart components behind it.
 *
 * A ReferenceError in here is a blank tab, and the one day it would be found
 * by using the page is the one day there is no time to fix it. So the panel is
 * rendered for real against synthetic events, in a sandbox with just enough
 * DOM for the module-level lines to run.
 */
function loadPanel(stateOverrides) {
    const PANEL_START = 'const $ = (sel, root) =>';
    // Up to, but not including, the app's own `state` — the TABS array names
    // every panel, so the slice has to carry all of them, and stopping here
    // lets the test supply the state the panel reads.
    const PANEL_END = 'const state = {';
    const a = PAGE.indexOf(PANEL_START);
    const b = PAGE.indexOf(PANEL_END);
    if (a < 0 || b < 0 || b <= a) throw new Error('could not slice the panel section out of stats/index.html');

    const stub = () => ({ style: {}, innerHTML: '', textContent: '', dataset: {}, appendChild() {}, closest: () => null });
    const store = new Map();
    const sandbox = {
        console,
        Intl,
        TextEncoder,
        TextDecoder,
        state: Object.assign({ days: 30, featHours: 6, charts: { rows: [], at: 0, running: false, done: 0, total: 0 }, chartsAuto: false }, stateOverrides),
        document: { querySelector: stub, querySelectorAll: () => [], addEventListener() {}, createElement: stub },
        window: { addEventListener() {} },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
        fetch: () => Promise.reject(new Error('no network in the smoke test')),
    };
    vm.createContext(sandbox);
    new vm.Script(PAGE.slice(a, b)).runInContext(sandbox);
    return sandbox;
}

const HOUR = 3600000;

/** A completed scan where nothing charted — the common, and correct, result. */
const STOREFRONT_MISS = ['us', 'de', 'jp'].map((cc) => ({ cc, health: 0, overall: 0, error: '' }));

/** `n` installs in one country, `hoursAgo` hours back. */
function installs(country, n, hoursAgo, opts = {}) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            event: 'funnel',
            deviceID: `${country}-${hoursAgo}-${i}-${opts.tag || ''}`,
            ts: Date.now() - hoursAgo * HOUR,
            params: {
                step: 'first_open',
                country,
                source: opts.source || 'organic',
            },
        });
    }
    return out;
}

/* --------------------------------------------------------------------------
   1. Install lift
   -------------------------------------------------------------------------- */

{
    const { featuring } = load();

    // Launch day: every market multiplies at once. Baseline (10h ago) is
    // 40/20/20/20; the recent window is exactly 3x that, so every share is
    // unchanged and nothing is featured.
    const evenLaunch = [
        ...installs('US', 40, 10), ...installs('DE', 20, 10),
        ...installs('GB', 20, 10), ...installs('FR', 20, 10),
        ...installs('US', 120, 1, { tag: 'r' }), ...installs('DE', 60, 1, { tag: 'r' }),
        ...installs('GB', 60, 1, { tag: 'r' }), ...installs('FR', 60, 1, { tag: 'r' }),
    ];
    const even = featuring(evenLaunch, 6);
    check('a launch that triples every market flags nobody', (() => {
        const p = [];
        if (even.recentTotal !== 300) p.push(`recent total ${even.recentTotal}, expected 300`);
        if (even.flagged.length) {
            p.push(`flagged ${even.flagged.map((r) => `${r.country} ${r.lift}x`).join(', ')} — a raw-count threshold, not a share one`);
        }
        return p;
    })());

    // Same launch, except Japan goes from 5% of installs to roughly half.
    const featured = [
        ...installs('US', 40, 10), ...installs('DE', 20, 10),
        ...installs('GB', 20, 10), ...installs('JP', 5, 10),
        ...installs('US', 120, 1, { tag: 'r' }), ...installs('DE', 60, 1, { tag: 'r' }),
        ...installs('GB', 60, 1, { tag: 'r' }), ...installs('JP', 240, 1, { tag: 'r' }),
    ];
    const jp = featuring(featured, 6);
    check('a country whose share of installs jumps is flagged', (() => {
        const p = [];
        const names = jp.flagged.map((r) => r.country);
        if (!names.includes('JP')) p.push(`flagged ${names.join(', ') || 'nothing'} — JP missing`);
        if (names.length !== 1) p.push(`flagged ${names.length} countries, expected only JP`);
        const row = jp.rows.find((r) => r.country === 'JP');
        if (!row) p.push('JP absent from the table');
        else if (!(row.lift > 5)) p.push(`JP lift ${row.lift}, expected well above 5x`);
        return p;
    })());

    // A handful of installs in a market that had none is infinite lift and
    // means nothing. The floor is what keeps it out of the table.
    const tiny = featuring([
        ...installs('US', 200, 10),
        ...installs('US', 200, 1, { tag: 'r' }),
        ...installs('MT', 3, 1, { tag: 'r' }),
    ], 6);
    check('a market too small to mean anything is not flagged', (() => {
        const p = [];
        const names = tiny.flagged.map((r) => r.country);
        if (names.includes('MT')) p.push(`MT flagged on ${tiny.rows.find((r) => r.country === 'MT').installs} installs`);
        if (tiny.minVolume < 5) p.push(`volume floor is ${tiny.minVolume}, below the hard minimum of 5`);
        return p;
    })());

    // An invite wave or a press link produces the same spike shape as a
    // feature. Attribution is what separates them.
    const press = featuring([
        ...installs('US', 100, 10), ...installs('IT', 5, 10),
        ...installs('US', 100, 1, { tag: 'r' }),
        ...installs('IT', 200, 1, { tag: 'r', source: 'invite_link' }),
    ], 6);
    check('an attributed spike is not mistaken for a feature', (() => {
        const p = [];
        const names = press.flagged.map((r) => r.country);
        if (names.includes('IT')) p.push('IT flagged, but its installs all carry invite attribution');
        const row = press.rows.find((r) => r.country === 'IT');
        if (row && row.organic !== 0) p.push(`IT organic count ${row.organic}, expected 0`);
        return p;
    })());

    // The same install replayed must not inflate a country.
    const dupes = installs('DE', 1, 1).concat(installs('DE', 1, 1));
    check('one device counts once however often it appears', (() => {
        const f = featuring(dupes, 6);
        return f.recentTotal === 1 ? [] : [`counted ${f.recentTotal} installs from one device`];
    })());

    // Before the first pre-launch install there is nothing to over-index
    // against, and the panel has to say so rather than invent a lift.
    const noBase = featuring(installs('US', 50, 1), 6);
    check('no baseline reports honestly instead of inventing a lift', (() => {
        const p = [];
        if (noBase.hasBaseline) p.push('claims a baseline it does not have');
        const row = noBase.rows[0];
        if (row.lift !== null) p.push(`lift ${row.lift}, expected null`);
        if (row.baseShare !== null) p.push(`baseShare ${row.baseShare}, expected null`);
        return p;
    })());

    check('hourly series carries one bucket per hour and a rest-of-world row', (() => {
        const p = [];
        const f = featuring(evenLaunch, 6);
        if (f.hourly.length !== 5) p.push(`${f.hourly.length} series, expected 4 countries + rest`);
        if (!f.hourly.some((h) => h.country === '~rest')) p.push('no rest-of-world series');
        for (const h of f.hourly) {
            if (h.shares.length !== f.hourSpan) p.push(`${h.country} has ${h.shares.length} points, span is ${f.hourSpan}`);
        }
        if (f.hourLabels.length !== f.hourSpan) p.push(`${f.hourLabels.length} labels for ${f.hourSpan} buckets`);
        return p;
    })());

    /* ---- the panel renders, in each state it can be caught in ---- */

    const render = (name, events, overrides) => check(`the panel renders ${name}`, (() => {
        try {
            const sb = loadPanel(overrides);
            const html = sb.panelFeaturing(events);
            if (typeof html !== 'string' || html.length < 200) return [`produced ${html && html.length} characters`];
            if (/undefined|NaN|\[object Object\]/.test(html)) {
                const bad = html.match(/.{0,60}(undefined|NaN|\[object Object\]).{0,60}/)[0];
                return [`leaked a placeholder into the page: …${bad}…`];
            }
            return [];
        } catch (e) {
            return [`threw ${e && e.message ? e.message : e}`];
        }
    })());

    render('before the first storefront scan', featured);
    render('with no events at all', []);
    render('mid-scan', featured, { charts: { rows: [], at: 0, running: true, done: 12, total: 59 } });
    render('with a scan that found nothing', featured, {
        charts: { rows: STOREFRONT_MISS, at: Date.now() - 60000, running: false, done: 0, total: 0 },
    });
    render('with storefronts charting', featured, {
        charts: {
            rows: [{ cc: 'jp', health: 4, overall: 61, error: '' }, { cc: 'br', health: 33, overall: 0, error: '' },
                { cc: 'us', health: 0, overall: 0, error: '' }, { cc: 'cn', health: 0, overall: 0, error: 'HTTP 503' }],
            at: Date.now() - 60000, running: false, done: 0, total: 0,
            prev: { at: Date.now() - 660000, ranks: { jp: 40, br: 33, us: 0 } },
        },
    });

    check('non-install events are ignored', (() => {
        const noise = [
            { event: 'screen_view', deviceID: 'x', ts: Date.now(), params: { country: 'US' } },
            { event: 'funnel', deviceID: 'y', ts: Date.now(), params: { step: 'group_joined', country: 'US' } },
        ];
        const f = featuring(noise, 6);
        return f.recentTotal === 0 ? [] : [`counted ${f.recentTotal} installs from events that are not first_open`];
    })());
}

/* --------------------------------------------------------------------------
   2. Storefront chart scan
   -------------------------------------------------------------------------- */

/** A legacy-RSS feed body holding `names` in order. */
function feed(entries) {
    return {
        feed: {
            entry: entries.map((e) => ({
                'im:name': { label: e.name },
                id: { attributes: { 'im:id': e.id || '000', 'im:bundleId': e.bundle || 'com.other.app' } },
            })),
        },
    };
}

const OURS = { name: 'Cardio Clowns', id: '6761773257', bundle: 'com.davidnguyen.Cardio-Clowns' };

function stubFetch(routes) {
    return (url) => {
        const hit = routes(url);
        if (hit === undefined) return Promise.resolve({ ok: false, status: 503 });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit) });
    };
}

{
    const seen = [];
    const { rankIn, APP_STORE_ID, BUNDLE_ID } = load(stubFetch((url) => {
        seen.push(url);
        if (url.includes('/jp/')) return feed([{ name: 'A' }, OURS, { name: 'B' }]);
        if (url.includes('/us/')) return feed([{ name: 'A' }, { name: 'B' }]);
        // An app-id-only match: the bundle id in the feed is wrong but the
        // numeric id is ours, which is what a storefront redirect looks like.
        if (url.includes('/de/')) return feed([{ name: 'X', id: APP_STORE_ID, bundle: 'com.stale.id' }]);
        if (url.includes('/fr/')) return { feed: {} };                  // storefront with no chart
        // A storefront with exactly one charting app answers with a bare
        // object where every other storefront answers with an array.
        if (url.includes('/it/')) return { feed: { entry: feed([OURS]).feed.entry[0] } };
        return undefined;                                              // 503
    }));

    // Read from appstore.js rather than hard-coded here: two copies of the
    // same literal in two files drift together in silence, and a stats page
    // matching on last season's id reports "not charting anywhere" forever.
    check('the ids the scan matches on are the shipping ones', (() => {
        const p = [];
        const src = fs.readFileSync(path.join(ROOT, 'appstore.js'), 'utf8');
        const m = src.match(/var APP_STORE_ID = '([^']*)';/);
        if (!m) p.push('could not read APP_STORE_ID out of appstore.js — declaration changed shape');
        else if (APP_STORE_ID !== m[1]) p.push(`stats/index.html matches on ${APP_STORE_ID}, appstore.js ships ${m[1]}`);
        if (BUNDLE_ID !== 'com.davidnguyen.Cardio-Clowns') p.push(`BUNDLE_ID is ${BUNDLE_ID}`);
        return p;
    })());

    (async () => {
        const problems = [];
        if (await rankIn('jp', '6013') !== 2) problems.push('did not find us at rank 2 in JP');
        if (await rankIn('us', '6013') !== 0) problems.push('claimed a rank in a chart we are not in');
        if (await rankIn('de', '6013') !== 1) problems.push('did not match on the numeric app id');
        if (await rankIn('fr', '6013') !== 0) problems.push('threw or mis-ranked on a feed with no entries');
        if (await rankIn('it', '6013') !== 1) problems.push('did not handle a feed whose single entry is not an array');
        let threw = false;
        try { await rankIn('zz', '6013'); } catch (e) { threw = true; }
        if (!threw) problems.push('a failed request passed silently as "not charting"');
        check('rank lookup reads every feed shape Apple returns', problems);

        /* ---- the sweep ---- */

        const calls = [];
        const { scanCharts, STOREFRONTS } = load(stubFetch((url) => {
            calls.push(url);
            const cc = url.split('/')[3];
            if (cc === 'jp') return feed([{ name: 'A' }, OURS]);
            if (cc === 'br') return feed([OURS]);
            if (cc === 'us') return undefined;                    // unreadable
            return feed([{ name: 'A' }]);
        }));

        let progress = 0;
        const rows = await scanCharts(() => { progress++; });

        check('the sweep visits every storefront exactly once', (() => {
            const p = [];
            if (rows.length !== STOREFRONTS.length) p.push(`${rows.length} rows for ${STOREFRONTS.length} storefronts`);
            if (progress !== STOREFRONTS.length) p.push(`progress fired ${progress} times`);
            const ccs = new Set(rows.map((r) => r.cc));
            for (const cc of STOREFRONTS) if (!ccs.has(cc)) p.push(`${cc} never checked`);
            return p;
        })());

        check('charting storefronts sort to the top, best rank first', (() => {
            const p = [];
            if (rows[0].cc !== 'br' || rows[0].health !== 1) p.push(`first row is ${rows[0].cc} #${rows[0].health}, expected br #1`);
            if (rows[1].cc !== 'jp' || rows[1].health !== 2) p.push(`second row is ${rows[1].cc} #${rows[1].health}, expected jp #2`);
            if (rows[rows.length - 1].cc !== 'us') p.push(`last row is ${rows[rows.length - 1].cc}, expected the unreadable one (us)`);
            if (!rows[rows.length - 1].error) p.push('the unreadable storefront carries no error');
            return p;
        })());

        check('the overall chart is fetched only where we already chart', (() => {
            const overall = calls.filter((u) => !u.includes('genre='));
            const ccs = overall.map((u) => u.split('/')[3]).sort();
            return JSON.stringify(ccs) === JSON.stringify(['br', 'jp'])
                ? []
                : [`overall chart fetched for ${ccs.join(', ') || 'nothing'}, expected only br, jp`];
        })());

        /* ---- the storefront list ---- */

        // Every territory in a filed nomination, plus the majors we did not
        // nominate: a feature can land somewhere nobody asked for, and a
        // storefront missing here is simply never looked at.
        const NOMINATED = [
            'us', 'gb', 'de', 'at', 'ch', 'fr', 'it', 'es', 'nl', 'se', 'no', 'dk', 'fi',
            'pl', 'cz', 'sk', 'si', 'hr', 'hu', 'ro', 'gr', 'cy', 'ua', 'ru', 'tr', 'il',
            'sa', 'ae', 'eg', 'qa', 'kw', 'bh', 'om', 'jo', 'lb',
            'ca', 'mx', 'br', 'jp', 'kr', 'cn', 'tw', 'hk', 'my', 'th', 'id', 'vn', 'in', 'au',
        ];
        check('every nominated territory is in the scan list', (() => {
            const p = [];
            const set = new Set(STOREFRONTS);
            for (const cc of NOMINATED) if (!set.has(cc)) p.push(`${cc} nominated but never scanned`);
            if (set.size !== STOREFRONTS.length) p.push('the scan list contains duplicates');
            for (const cc of STOREFRONTS) if (!/^[a-z]{2}$/.test(cc)) p.push(`"${cc}" is not a lowercase ISO-3166 alpha-2 code`);
            return p;
        })());

        /* ---- snapshot round trip, which is what makes the deltas work ---- */

        const snap = load();
        snap.saveChartSnapshot([{ cc: 'jp', health: 12 }, { cc: 'us', health: 0 }, { cc: 'xx', health: 3, error: 'boom' }], 1000);
        const back = snap.loadChartSnapshot();
        check('a scan snapshot survives a round trip, minus the failures', (() => {
            const p = [];
            if (!back) return ['nothing came back'];
            if (back.ranks.jp !== 12) p.push(`jp came back as ${back.ranks.jp}`);
            if (back.ranks.us !== 0) p.push('a storefront we are not charting in was dropped, so it can never read "new"');
            if ('xx' in back.ranks) p.push('an unreadable storefront was stored, and will read as "dropped out" next scan');
            if (back.at !== 1000) p.push(`timestamp came back as ${back.at}`);
            return p;
        })());

        check('a missing snapshot is absence, not a crash', (() => {
            const fresh = load();
            return fresh.loadChartSnapshot() === null ? [] : ['expected null before the first scan'];
        })());

        console.log();
        if (failures) {
            console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
            process.exit(1);
        }
        console.log(`\x1b[32mall ${checks} checks passed\x1b[0m`);
    })().catch((e) => {
        console.log(`  FAIL  unexpected error: ${e && e.stack ? e.stack : e}`);
        process.exit(1);
    });
}

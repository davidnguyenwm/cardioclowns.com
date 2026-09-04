/*
 * Rating-prompt tests. Run: node tests/ratings.test.js
 *
 * WHY THIS EXISTS
 *
 * The Ratings tab answers a question nobody can answer any other way: how
 * often does the app ask for a rating, and what does the asking produce. Every
 * way it can be wrong is silent.
 *
 *   - Asks and blocks are counted in DIFFERENT UNITS. An ask is one event per
 *     ask; a block is throttled in the app to once per device per day, so it
 *     is device-days. Add them into one funnel and the gates look ten times
 *     more common than they are — a mistake that reads as a plausible number.
 *
 *   - Two devices (the fastlane screenshot runner and the developer's own
 *     phone) write real events into production. They hold every ask past the
 *     third, so leaving them in makes Apple's three-per-year ceiling look like
 *     something users are hitting. The filter has no visible symptom when it
 *     breaks; the numbers just get bigger.
 *
 *   - The review feed returns a bare object rather than an array when a
 *     storefront has exactly one review, and omits the key entirely when it
 *     has none. Both shapes throw or silently count zero in the obvious
 *     implementation, and both are the NORMAL state for a young app — which is
 *     exactly when someone is looking at this tab.
 *
 *   - The star counts come from a file `scripts/store_ratings.py` writes,
 *     because Apple's lookup endpoint withholds its CORS header from browser
 *     user-agents. That is a contract between two repositories with nothing
 *     enforcing it, so the shape is checked here.
 *
 * Dependency-free on purpose: this repo is static files on GitHub Pages and
 * has no package.json. Keep it that way.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'stats', 'index.html'), 'utf8');

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

   The page script boots itself, so the slice from the first helper up to the
   app's own `state` is run alone — the same seam tests/featuring.test.js uses.
   If it ever moves, this fails loudly rather than quietly testing nothing.
   -------------------------------------------------------------------------- */

const START = 'const $ = (sel, root) =>';
const END = 'const state = {';
const from = PAGE.indexOf(START);
const to = PAGE.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
    console.log('  FAIL  locate the page script in stats/index.html');
    console.log(`          start marker ${from < 0 ? 'missing' : 'at ' + from}, end marker ${to < 0 ? 'missing' : 'at ' + to}`);
    process.exit(1);
}

// Function declarations land on the sandbox global by themselves; `const`
// bindings do not, so the ones under test are handed over explicitly.
const SECTION = PAGE.slice(from, to)
    + '\n;Object.assign(globalThis, { TEST_DEVICES, GATES, STOREFRONTS, REVIEWS_PAGE_SIZE, APP_STORE_ID });\n';

const stub = () => ({ style: {}, innerHTML: '', textContent: '', dataset: {}, appendChild() {}, closest: () => null });

/** Fresh sandbox per test, so one test's fetch stub can't leak into the next. */
function load(overrides) {
    const store = new Map();
    const sandbox = Object.assign({
        console,
        Intl,
        TextEncoder,
        TextDecoder,
        state: { days: 30, tab: 'ratings', ratings: { rows: [], at: 0, running: false, done: 0, total: 0 }, ratingCounts: null },
        document: { querySelector: stub, querySelectorAll: () => [], addEventListener() {}, createElement: stub },
        window: { addEventListener() {} },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
        fetch: () => Promise.reject(new Error('no fetch stub')),
    }, overrides);
    vm.createContext(sandbox);
    new vm.Script(SECTION).runInContext(sandbox);
    return sandbox;
}

/* Event builders. `ts` defaults to now so the day-series lands in the window. */
const ask = (deviceID, extra) => Object.assign(
    { event: 'cta_tap', params: { cta: 'review_prompted', reason: 'crown_won' }, deviceID, ts: Date.now() }, extra
);
const block = (deviceID, reason, extra) => Object.assign(
    { event: 'review_prompt_blocked', params: { reason }, deviceID, ts: Date.now() }, extra
);

/* ==========================================================================
   1. Asks and blocks are different units
   ========================================================================== */

console.log('\nasks and blocks never merge');
{
    const { reviews } = load();
    const r = reviews([
        ask('a'), ask('a'), ask('b'),
        block('c', 'no_moment'), block('c', 'no_moment'), block('d', 'tenure'),
    ], 30);

    eq('asks count events, not people', r.asks, 3);
    eq('  …and the people are counted separately', r.askDevices, 2);
    eq('blocks count device-days, not people', r.blocks, 3);
    eq('  …with their own device count', r.blockDevices, 2);
    eq('everyone the gates ran on is one population', r.evaluated, 4);
    check('the two are never summed into one total',
        Object.prototype.hasOwnProperty.call(r, 'total') ? ['`total` exists — asks and blocks are in different units and must not be added'] : []);
}

/* ==========================================================================
   2. The test devices stay out
   ========================================================================== */

console.log('\nthe screenshot runner and the developer phone stay out');
{
    const { reviews, TEST_DEVICES } = load();
    check('both known test devices are named',
        ['screenshotme', 'DC88AE60-5178-46CE-90BA-695615E4B721'].filter((d) => !TEST_DEVICES.has(d)).map((d) => `${d} is not excluded`));

    const r = reviews([
        ask('real'),
        ask('screenshotme'), ask('screenshotme'), ask('screenshotme'), ask('screenshotme'),
        block('DC88AE60-5178-46CE-90BA-695615E4B721', 'cooldown'),
    ], 30);

    eq('their asks are dropped', r.asks, 1);
    eq('their blocks are dropped', r.blocks, 0);
    eq('they never reach the ceiling counts', r.overQuota, 0);
    eq('the drop is reported, not hidden', r.excluded, 5);
}

/* ==========================================================================
   3. Apple's three-per-year ceiling
   ========================================================================== */

console.log("\nApple's ceiling");
{
    const { reviews } = load();
    const r = reviews([
        ask('three'), ask('three'), ask('three'),
        ask('four'), ask('four'), ask('four'), ask('four'),
        ask('one'),
    ], 30);

    eq('a device asked exactly three times is at the ceiling', r.atCeiling, 1);
    eq('a fourth ask is past it', r.overQuota, 1);
    eq('one ask is neither', r.spread.find((x) => x.key === '1 ask').value, 1);
    check('the spread is ordered by asks, ascending',
        r.spread.map((x) => x.key).join('|') === '1 ask|3 asks|4 asks'
            ? [] : [`got ${r.spread.map((x) => x.key).join('|')}`]);
}

/* ==========================================================================
   4. Each device counted once, at its best state
   ========================================================================== */

console.log('\nhow far each person got');
{
    const { reviews, GATES } = load();
    check('the gates are in the order shouldPromptNow checks them',
        GATES.map((g) => g.id).join('|') === 'no_moment|no_real_friends|tenure|cooldown'
            ? [] : [`got ${GATES.map((g) => g.id).join('|')}`]);

    const r = reviews([
        // One phone, blocked twice on the way to being asked. It is one person.
        block('journey', 'no_moment'), block('journey', 'tenure'), ask('journey'),
        // One that never got anywhere.
        block('stuck', 'no_moment'),
        // One that banked a moment but has no rival.
        block('lonely', 'no_real_friends'),
    ], 30);

    const ladder = Object.fromEntries(r.ladder.map((x) => [x.key, x.value]));
    const total = r.ladder.reduce((a, b) => a + b.value, 0);
    eq('every device lands on exactly one rung', total, 3);
    eq('  …the asked one on "Asked"', ladder.Asked, 1);
    eq('  …and not also on the gate that blocked it earlier', ladder['Too new to ask'], 0);
    eq('a device stuck at the first gate stays there', ladder['Nothing good has happened yet'], 1);
    eq('a device with a moment but no rival is one rung up', ladder['Racing bots only'], 1);
}

/* ==========================================================================
   5. The day series
   ========================================================================== */

console.log('\nasks per day');
{
    const { reviews } = load();
    const day = 86400000;
    const r = reviews([ask('a'), ask('b', { ts: Date.now() - 3 * day })], 7);
    eq('one point per day in the window', r.series.length, 7);
    eq('one label per point', r.labels.length, 7);
    eq('a quiet day is a zero, not a gap', r.series.filter((n) => n === 0).length, 5);
    eq('every ask lands somewhere', r.series.reduce((a, b) => a + b, 0), 2);

    const old = reviews([ask('a', { ts: Date.now() - 90 * day })], 7);
    eq('an ask older than the window is not drawn', old.series.reduce((a, b) => a + b, 0), 0);
    check('  …but it is still counted in the totals, like every other panel',
        old.asks === 1 ? [] : [`expected the caller's window to own the filtering, got asks=${old.asks}`]);
}

/* ==========================================================================
   6. The review feed's awkward shapes
   ========================================================================== */

console.log('\nthe review feed');

/** A feed response with whatever `entry` shape a test wants. */
function feed(entry) {
    const body = { feed: { author: {}, updated: {} } };
    if (entry !== undefined) body.feed.entry = entry;
    return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
const entry = (stars, extra) => Object.assign({
    'im:rating': { label: String(stars) },
    'im:version': { label: '1.0.1' },
    title: { label: 'Title' },
    content: { label: 'Body' },
    author: { name: { label: 'Someone' } },
    updated: { label: '2026-09-01T10:00:00-07:00' },
}, extra);

(async () => {
    {
        // The three shapes Apple actually returns, and only one of them is a list.
        const none = load({ fetch: () => Promise.resolve(feed(undefined)) });
        const one = load({ fetch: () => Promise.resolve(feed(entry(5))) });
        const many = load({ fetch: () => Promise.resolve(feed([entry(5), entry(1)])) });

        eq('a storefront with no reviews has no `entry` key at all', (await none.reviewsIn('us')).reviews.length, 0);
        eq('a storefront with one review returns a bare object', (await one.reviewsIn('us')).reviews.length, 1);
        eq('a storefront with several returns an array', (await many.reviewsIn('us')).reviews.length, 2);

        const bad = load({ fetch: () => Promise.resolve(feed([entry(0), entry(9), entry(4)])) });
        eq('a rating outside 1–5 is malformed, not a review', (await bad.reviewsIn('us')).reviews.length, 1);

        const fields = (await one.reviewsIn('de')).reviews[0];
        eq('the storefront rides along on every review', fields.cc, 'de');
        eq('stars are numbers, not strings', fields.stars, 5);
        eq('the version is kept', fields.version, '1.0.1');
        check('the date is parsed', fields.at > 0 ? [] : ['updated did not parse to a timestamp']);
    }

    {
        const s = load();
        const t = s.reviewTotals([
            { cc: 'us', reviews: [{ cc: 'us', stars: 5, at: 3 }, { cc: 'us', stars: 1, at: 1 }], full: false },
            { cc: 'de', reviews: [{ cc: 'de', stars: 3, at: 2 }], full: true },
            { cc: 'gb', reviews: [], full: false },
            { cc: 'sg', reviews: [], full: false, error: 'HTTP 503' },
        ]);
        eq('reviews are totalled across storefronts', t.count, 3);
        eq('the average is over the written ones', t.avg, 3);
        eq('one star lands in the first bucket', t.stars[0], 1);
        eq('five stars land in the last', t.stars[4], 1);
        eq('only storefronts with reviews are "rated"', t.stores, 2);
        eq('a full page is flagged as undercounted', t.capped.join(), 'de');
        eq('an unreadable storefront is not a silent zero', t.errors.length, 1);
        eq('  …and is not counted as read', t.read, 3);
        eq('the newest review is first', t.all[0].at, 3);
    }

    /* ======================================================================
       7. The star-count file, written by the other repo
       ====================================================================== */

    console.log('\nthe star-count file');
    {
        const missing = load({ fetch: () => Promise.resolve({ ok: false, status: 404 }) });
        eq('no file is null, not an empty reading', await missing.loadRatingCounts(), null);

        const broken = load({ fetch: () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) }) });
        eq('unparseable is null too', await broken.loadRatingCounts(), null);

        const wrong = load({ fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ count: 7 }) }) });
        eq('a file without storefronts is not a rating count', await wrong.loadRatingCounts(), null);

        const good = { at: 1, stores: [{ cc: 'us', count: 3, avg: 4.5, verCount: 1 }], count: 3, avg: 4.5, verCount: 1, version: '1.0.1' };
        const ok = load({ fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(good) }) });
        eq('a real file comes through', (await ok.loadRatingCounts()).count, 3);
    }

    {
        // The file is written by scripts/store_ratings.py in the app repo. If
        // it is checked in here, it has to carry what the panel reads.
        const file = path.join(ROOT, 'stats', 'ratings.json');
        if (!fs.existsSync(file)) {
            check('a committed ratings.json carries what the panel reads', ['no stats/ratings.json yet — run scripts/store_ratings.py in the app repo']);
        } else {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const missing = ['at', 'count', 'avg', 'verCount', 'version', 'stores'].filter((k) => !(k in data));
            const storeKeys = data.stores.length
                ? ['cc', 'count', 'avg', 'verCount'].filter((k) => !(k in data.stores[0])) : [];
            check('the committed ratings.json carries what the panel reads',
                missing.map((k) => `top-level "${k}" missing`).concat(storeKeys.map((k) => `store rows missing "${k}"`)));
            check('  …and its app id is ours',
                !data.appStoreId || data.appStoreId === load().APP_STORE_ID ? []
                    : [`ratings.json is for app ${data.appStoreId}, the page is for ${load().APP_STORE_ID}`]);
        }
    }

    /* ======================================================================
       8. The panel renders — a ReferenceError here is a blank tab
       ====================================================================== */

    console.log('\nthe panel itself');
    {
        const events = [ask('a'), ask('b'), block('c', 'no_moment'), block('d', 'cooldown')];
        const cases = [
            ['nothing read yet', { ratings: { rows: [], at: 0, running: false, done: 0, total: 0 }, ratingCounts: null }],
            ['mid-sweep', { ratings: { rows: [], at: 0, running: true, done: 7, total: 59 }, ratingCounts: null }],
            ['swept, nothing written', {
                ratings: { rows: [{ cc: 'us', reviews: [], full: false }], at: Date.now(), running: false, done: 0, total: 0 },
                ratingCounts: null,
            }],
            ['swept, with reviews and counts', {
                ratings: {
                    rows: [{ cc: 'us', reviews: [{ cc: 'us', stars: 4, version: '1.0.1', title: 'Fun', text: 'Good', author: 'Me', at: Date.now() }], full: true }],
                    at: Date.now(), running: false, done: 0, total: 0,
                },
                ratingCounts: { at: 1, count: 9, avg: 4.4, verCount: 2, version: '1.0.1', stores: [{ cc: 'us', count: 9, avg: 4.4, verCount: 2 }] },
            }],
            ['no events at all', { ratings: { rows: [], at: 0, running: false, done: 0, total: 0 }, ratingCounts: null }, []],
        ];

        for (const [name, overrides, evOverride] of cases) {
            const s = load();
            Object.assign(s.state, overrides);
            let html = '', err = null;
            try { html = s.panelRatings(evOverride || events, 30); } catch (e) { err = e; }
            check(`renders: ${name}`, err ? [String(err && err.stack ? err.stack.split('\n')[0] : err)] : []);
            check(`  …with nothing undefined in it`, /undefined|NaN|\[object Object\]/.test(html)
                ? [html.match(/.{0,50}(undefined|NaN|\[object Object\]).{0,50}/)[0]] : []);
        }
    }

    {
        // The tab has to be reachable, and the gates card must live in exactly
        // one place — it used to be on Growth, and two copies drift apart.
        const s = load();
        check('the Ratings tab is registered', /\{ id: "ratings", name: "Ratings", render: panelRatings \}/.test(PAGE)
            ? [] : ['TABS has no ratings entry']);
        check('the review gates are only on the Ratings tab',
            (PAGE.match(/Why the prompt didn.t fire|Why the review prompt didn.t fire/g) || []).length === 1
                ? [] : ['the gate card appears more than once — Growth used to own it']);
        eq('the sweep and the page agree on the feed page size', s.REVIEWS_PAGE_SIZE, 50);
    }

    console.log();
    if (failures) {
        console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
        process.exit(1);
    }
    console.log(`\x1b[32mall ${checks} checks passed\x1b[0m`);
})();

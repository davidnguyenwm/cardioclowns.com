/*
 * Website analytics tests. Run: node tests/analytics.test.js
 *
 * WHY THIS EXISTS
 *
 * analytics.js is a file whose correct behaviour today is to do nothing at all.
 * It is inert until CF_BEACON_TOKEN is swapped for a real one, which means the
 * entire thing — the token gate, the opt-out handling, the beacon shape — has
 * never actually run. It gets its first real execution on launch day, on the
 * live site, on the one day nobody is reading the console.
 *
 * Two ways that goes wrong, both silent:
 *
 *   - It stays inert after the token is filled in (a typo'd token, a gate that
 *     rejects the real format) and the launch is unmeasured.
 *   - It wakes up but ignores opt-out signals, which turns "measures pages, not
 *     people" in the privacy policy into a false statement.
 *
 * Dependency-free on purpose — this repo is static files on GitHub Pages and
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

const ANALYTICS_SRC = fs.readFileSync(path.join(ROOT, 'analytics.js'), 'utf8');
const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const REAL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * Runs analytics.js with the token patched and the given privacy signals set,
 * and reports what it appended to the document.
 *
 * `runs` executes the file more than once in the same sandbox — the way a page
 * that includes the script twice would behave.
 */
function run(options = {}) {
    let src = ANALYTICS_SRC;
    if (options.token !== undefined) {
        const pattern = /var TOKEN = '[^']*';/;
        if (!pattern.test(src)) throw new Error('could not patch TOKEN — declaration changed shape');
        src = src.replace(pattern, `var TOKEN = '${options.token}';`);
    }

    const appended = [];
    const document = {
        head: { appendChild(node) { appended.push(node); } },
        createElement(tag) {
            return { tagName: tag.toUpperCase(), setAttribute(k, v) { this[k] = v; } };
        },
        querySelector(sel) {
            const m = sel.match(/^script\[src="([^"]+)"\]$/);
            if (!m) return null;
            return appended.find((n) => n.src === m[1]) || null;
        }
    };

    const navigator = {};
    if ('doNotTrack' in options) navigator.doNotTrack = options.doNotTrack;
    if ('msDoNotTrack' in options) navigator.msDoNotTrack = options.msDoNotTrack;
    if ('gpc' in options) navigator.globalPrivacyControl = options.gpc;

    const sandbox = { document, navigator, window: {} };
    if ('windowDoNotTrack' in options) sandbox.window.doNotTrack = options.windowDoNotTrack;

    for (let i = 0; i < (options.runs || 1); i++) {
        vm.runInNewContext(src, sandbox, { filename: 'analytics.js' });
    }
    return appended;
}

const tokenIsPlaceholder = /var TOKEN = 'CF_BEACON_TOKEN';/.test(ANALYTICS_SRC);
console.log(`analytics.js: token ${tokenIsPlaceholder ? 'is still the placeholder (site is inert)' : 'is set'}\n`);

/* ---------- 1. the gate that keeps the site request-free today ---------- */

check('the placeholder token makes no request at all', (() => {
    const problems = [];
    if (run({ token: 'CF_BEACON_TOKEN' }).length !== 0) {
        problems.push('the placeholder token injected a beacon — the site is making third-party requests pre-launch');
    }
    // Near-misses, because "looks like a token" is how a bad paste gets through.
    for (const bad of ['', 'abc', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), REAL_TOKEN + ' ']) {
        if (run({ token: bad }).length !== 0) problems.push(`malformed token '${bad.slice(0, 12)}…' was accepted`);
    }
    return problems;
})());

/* ---------- 2. what has to happen on launch day ---------- */

// This is the code path that has never run in production. If it is wrong, the
// symptom is an empty dashboard, discovered days later.
check('a real token injects a correctly shaped beacon', (() => {
    const appended = run({ token: REAL_TOKEN });
    if (appended.length !== 1) return [`expected exactly one script, got ${appended.length}`];

    const problems = [];
    const script = appended[0];
    if (script.tagName !== 'SCRIPT') problems.push(`appended a <${script.tagName.toLowerCase()}>, not a script`);
    if (script.src !== BEACON_SRC) problems.push(`src is ${script.src}`);
    if (script.defer !== true) problems.push('beacon is not deferred, so it competes with page render');
    // Cloudflare's own snippet is type="module". beacon.min.js is currently a
    // plain IIFE that runs either way, so a mismatch is silent today and fatal
    // the day they ship ESM — exactly the kind of failure this file exists for.
    if (script.type !== 'module') problems.push(`script type is '${script.type}', Cloudflare's snippet uses module`);

    const beacon = script['data-cf-beacon'];
    if (!beacon) {
        problems.push('no data-cf-beacon attribute — Cloudflare will not know which site this is');
    } else {
        let parsed;
        try { parsed = JSON.parse(beacon); } catch (e) { problems.push(`data-cf-beacon is not valid JSON: ${beacon}`); }
        if (parsed && parsed.token !== REAL_TOKEN) problems.push(`data-cf-beacon carries token '${parsed.token}'`);
    }
    return problems;
})());

check('an uppercase token is accepted (Cloudflare hands them out either way)', (() => {
    return run({ token: REAL_TOKEN.toUpperCase() }).length === 1
        ? []
        : ['an uppercase 32-character hex token was rejected'];
})());

/* ---------- 3. opt-out signals ---------- */

// The privacy policy promises this measures pages, not people. Honouring only
// one spelling of one obsolete signal would make that promise thinner than it
// sounds — and GPC is the one that carries actual legal weight.
check('every opt-out signal suppresses the beacon', (() => {
    const problems = [];
    const signals = [
        [{ doNotTrack: '1' }, "navigator.doNotTrack '1' (Chrome, Firefox)"],
        [{ doNotTrack: 'yes' }, "navigator.doNotTrack 'yes' (Safari, older Firefox)"],
        [{ windowDoNotTrack: '1' }, "window.doNotTrack '1'"],
        [{ msDoNotTrack: '1' }, "navigator.msDoNotTrack '1' (IE, old Edge)"],
        [{ gpc: true }, 'navigator.globalPrivacyControl (Brave, DuckDuckGo, Firefox)']
    ];
    for (const [signal, label] of signals) {
        if (run(Object.assign({ token: REAL_TOKEN }, signal)).length !== 0) {
            problems.push(`${label} was ignored — someone who opted out was counted`);
        }
    }
    return problems;
})());

check('an absent or negative signal still counts the page view', (() => {
    const problems = [];
    const allowed = [
        [{}, 'no signal set at all'],
        [{ doNotTrack: '0' }, "doNotTrack '0'"],
        [{ doNotTrack: null }, 'doNotTrack null'],
        [{ doNotTrack: 'unspecified' }, "doNotTrack 'unspecified'"],
        [{ gpc: false }, 'globalPrivacyControl false']
    ];
    for (const [signal, label] of allowed) {
        if (run(Object.assign({ token: REAL_TOKEN }, signal)).length !== 1) {
            problems.push(`${label} suppressed the beacon — the site would measure nothing`);
        }
    }
    return problems;
})());

/* ---------- 4. double counting ---------- */

check('including the script twice does not double every number', (() => {
    const appended = run({ token: REAL_TOKEN, runs: 2 });
    return appended.length === 1
        ? []
        : [`two includes produced ${appended.length} beacons — every figure on the dashboard would be doubled`];
})());

/* ---------- 5. no page ships unmeasured ---------- */

// A new page that forgets the include is invisible, and nothing about the page
// looks wrong. The exclusions are deliberate and named, so adding a page means
// choosing rather than forgetting.
check('every public page includes analytics.js', (() => {
    const PRIVATE = {
        'stats/index.html': 'private dashboard, noindex + disallowed in robots.txt',
        '_p.html': 'local screenshot harness, never deployed as a page',
        '_probe.html': 'local screenshot harness, never deployed as a page'
    };

    const pages = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'tests') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
            else if (entry.name.endsWith('.html')) pages.push(rel);
        }
    };
    walk(ROOT, '');

    const problems = [];
    for (const page of pages) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const included = html.includes('/analytics.js');
        if (included && page in PRIVATE) {
            problems.push(`${page} includes analytics.js but is documented as private (${PRIVATE[page]})`);
        } else if (!included && !(page in PRIVATE)) {
            problems.push(`${page} does not include /analytics.js — it would ship unmeasured`);
        }
    }
    for (const page of Object.keys(PRIVATE)) {
        if (!pages.includes(page)) problems.push(`${page} is listed as a private page but no longer exists — prune the list`);
    }
    return problems;
})());

/* ---------- 6. the policy has to describe what the beacon does ---------- */

// The beacon is a third-party request. The privacy policy is the thing that
// makes it honest, and it was also the subject of a past App Review rejection,
// so it is worth a check that it still says what the code does.
check('the privacy policy describes the website measurement', (() => {
    const policy = fs.readFileSync(path.join(ROOT, 'privacy/index.html'), 'utf8').toLowerCase();
    const problems = [];
    if (!policy.includes('cookieless')) problems.push("the policy does not describe the measurement as cookieless");
    for (const promise of ['no cookies', 'fingerprint']) {
        if (!policy.includes(promise)) problems.push(`the policy no longer mentions '${promise}'`);
    }
    return problems;
})());

/* ---------- summary ---------- */

console.log();
if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed`);
    process.exit(1);
}
console.log(`all ${checks} checks passed`);

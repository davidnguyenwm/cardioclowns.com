/*
 * App Store link and campaign-attribution tests. Run: node tests/appstore.test.js
 *
 * WHY THIS EXISTS
 *
 * Attribution fails silently in both directions and cannot be repaired after
 * the fact. A link missing `pt` still downloads the app; a campaign name that
 * collides still reports a number. Nothing throws, nothing 404s, and the only
 * symptom is a dashboard that looks fine and answers the wrong question — six
 * weeks later, with no way to backfill.
 *
 * Two specific failures motivated this file:
 *
 *   1. The press page ignored `?c=` entirely. 113 pitches carried a per-outlet
 *      token in the URL and every one of them reported as `web_press`, so
 *      "which outlet drove installs" had no answer at all.
 *   2. `pt=` is gated on PROVIDER_TOKEN being numeric, which it isn't yet. That
 *      gate is correct — never break a download over analytics — but it means
 *      the site can go live fully instrumented and attribute nothing.
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

/* ---------- load appstore.js under controlled conditions ---------- */

const APPSTORE_SRC = fs.readFileSync(path.join(ROOT, 'appstore.js'), 'utf8');

// A fake DOM that records what the banner and the link wiring actually wrote.
// Only the handful of methods appstore.js touches — a real DOM here would test
// jsdom rather than this file.
function fakeDocument(links) {
    const appended = [];
    return {
        head: {
            appendChild(node) { appended.push(node); }
        },
        createElement(tag) {
            return {
                tagName: tag.toUpperCase(),
                setAttribute(k, v) { this[k] = v; },
                getAttribute(k) { return this[k]; }
            };
        },
        querySelector(sel) {
            if (sel !== 'meta[name="apple-itunes-app"]') return null;
            return appended.find((n) => n.name === 'apple-itunes-app') || null;
        },
        querySelectorAll() { return links || []; },
        _appended: appended
    };
}

/**
 * Loads appstore.js with LAUNCHED / PROVIDER_TOKEN patched, so post-launch
 * behaviour is testable today without editing the shipped file.
 *
 * Every substitution is verified rather than assumed. A regex that stops
 * matching because the declaration was reworded would otherwise turn every
 * "after launch" test below into a second copy of the "before launch" tests —
 * all still passing, all testing nothing.
 */
function loadStore(options = {}) {
    let src = APPSTORE_SRC;
    const problems = [];

    // Verified by "did the pattern match", not by "did the text change" —
    // patching PROVIDER_TOKEN to the placeholder it already holds is a
    // legitimate no-op, and a diff-based check would call that a broken patch.
    const patch = (pattern, replacement, label) => {
        if (!pattern.test(src)) { problems.push(`could not patch ${label} — declaration changed shape`); return; }
        src = src.replace(pattern, replacement);
    };

    if (options.launched) {
        patch(/var LAUNCHED = false;/, 'var LAUNCHED = true;', 'LAUNCHED');
    }
    if (options.providerToken !== undefined) {
        patch(/var PROVIDER_TOKEN = '[^']*';/, `var PROVIDER_TOKEN = '${options.providerToken}';`, 'PROVIDER_TOKEN');
    }
    if (problems.length) throw new Error(problems.join('; '));

    const warnings = [];
    const document = fakeDocument(options.links);
    const sandbox = {
        window: { console: { warn: (msg) => warnings.push(msg) } },
        document,
        location: { search: options.search || '' },
        URLSearchParams
    };
    vm.runInNewContext(src, sandbox, { filename: 'appstore.js' });
    return { store: sandbox.window.CCStore, document, warnings };
}

// The shipped file, unpatched, is what actually serves today.
const shipped = loadStore();
const LIVE_TOKEN = '123456789';

console.log(
    `appstore.js: LAUNCHED=${/var LAUNCHED = true;/.test(APPSTORE_SRC)} ` +
    `· attribution ready=${shipped.store.attributionReady()}\n`
);

/* ---------- 1. the pre-launch contract ---------- */

// The whole point of the LAUNCHED switch is that everything else can be real
// and verifiable while the site still shows "Coming soon".
check('before launch nothing links to the App Store', (() => {
    const problems = [];
    if (shipped.store.isLive()) problems.push('isLive() is true but LAUNCHED has not been flipped');
    if (shipped.store.url('web_home') !== null) problems.push('url() returns a link before launch');

    const { document } = loadStore({ search: '?c=en_macstories' });
    if (document._appended.length !== 0) {
        problems.push('smartBanner() wrote a meta tag before launch');
    }
    return problems;
})());

/* ---------- 2. the bug that motivated this file ---------- */

// Every press pitch carries its own ?c= token. If the campaign name comes back
// as a bare 'web_press', all 113 of them are one number again.
check('?c= turns the press campaign into a per-outlet name', (() => {
    const { store } = loadStore({ launched: true, providerToken: LIVE_TOKEN, search: '?c=en_macstories' });
    const name = store.campaign('web_press');
    return name === 'web_press_en_macstories'
        ? []
        : [`campaign('web_press') with ?c=en_macstories produced '${name}'`];
})());

check('?m= and ?c= coexist, in either order', (() => {
    const problems = [];
    for (const search of ['?m=de&c=de_iphoneticker', '?c=de_iphoneticker&m=de']) {
        const { store } = loadStore({ launched: true, search });
        const name = store.campaign('web_press');
        if (name !== 'web_press_de_iphoneticker') {
            problems.push(`${search} produced '${name}' — the locale link and the token link are the same link`);
        }
    }
    return problems;
})());

check('a link with no token still reports under its base campaign', (() => {
    const problems = [];
    const cases = [
        ['', 'no query string at all'],
        ['?m=de', 'a locale link with no token'],
        ['?c=', 'an empty token']
    ];
    for (const [search, description] of cases) {
        const { store } = loadStore({ launched: true, search });
        const name = store.campaign('web_press');
        if (name !== 'web_press') problems.push(`${description} produced '${name}' instead of 'web_press'`);
    }
    return problems;
})());

/* ---------- 3. the token is untrusted input in a meta tag ---------- */

// The Smart App Banner's `content` is a comma-separated field list. A token
// carrying a comma doesn't corrupt the campaign name, it appends a new *field* —
// app-argument decides what URL the app opens with, from a link anyone can send
// to a journalist. This is the check that matters most in this file.
check('a crafted ?c= cannot inject Smart App Banner fields', (() => {
    const problems = [];
    const attacks = [
        '?c=x,app-argument=https://evil.example',
        '?c=x,app-clip-bundle-id=com.evil.clip',
        '?c=' + encodeURIComponent('x, app-argument=javascript:alert(1)'),
        '?c=' + encodeURIComponent('x&pt=999'),
        '?c=' + encodeURIComponent('x"onload="alert(1)')
    ];
    for (const search of attacks) {
        const { store, document } = loadStore({
            launched: true, providerToken: LIVE_TOKEN, search
        });
        store.smartBanner({ campaign: store.campaign('web_press') });
        const meta = document._appended.find((n) => n.name === 'apple-itunes-app');
        if (!meta) { problems.push(`${search} wrote no banner at all`); continue; }

        const fields = meta.content.split(',').map((f) => f.trim().split('=')[0]);
        const allowed = ['app-id', 'app-clip-bundle-id', 'app-clip-display', 'app-argument', 'affiliate-data'];
        const unexpected = fields.filter((f) => !allowed.includes(f));
        if (unexpected.length) problems.push(`${search} produced banner fields ${unexpected.join(', ')}`);
        if (meta.content.includes('app-argument')) {
            problems.push(`${search} injected app-argument into a banner that was never given one`);
        }
        if (!/affiliate-data=pt=\d+&ct=web_press$/.test(meta.content)) {
            problems.push(`${search} should fall back to the plain campaign, got: ${meta.content}`);
        }
    }
    return problems;
})());

// The check above can only reach affiliateData() through campaign(), which has
// already sanitised the value — so it passes even with the banner's own guard
// removed. This calls the banner directly with a dirty name, the way a future
// page that builds a campaign some other way would.
check('the banner rejects a dirty campaign name from any caller', (() => {
    const problems = [];
    const dirty = [
        'web_press,app-argument=https://evil.example',
        'web_press, app-clip-display=card',
        'web press'
    ];
    for (const name of dirty) {
        const { store, document } = loadStore({ launched: true, providerToken: LIVE_TOKEN });
        if (store.affiliateData(name).includes(name)) {
            problems.push(`affiliateData() passed '${name}' through untouched`);
        }
        store.smartBanner({ campaign: name });
        const meta = document._appended.find((n) => n.name === 'apple-itunes-app');
        if (meta && meta.content.includes('app-argument')) {
            problems.push(`smartBanner() let '${name}' inject app-argument`);
        }
        if (meta && meta.content.includes('app-clip-display')) {
            problems.push(`smartBanner() let '${name}' inject app-clip-display`);
        }
    }
    return problems;
})());

check('junk tokens are dropped whole, not scrubbed into a lookalike', (() => {
    const problems = [];
    // Dropping is the honest failure: 'web_press' says "a press reader, outlet
    // unknown". A scrubbed 'web_press_xappargumenthttpsevilexample' would be a
    // confident, permanent, wrong answer sitting in the dashboard.
    const junk = ['x,y', 'a b', 'a-b', 'a.b', 'a/b', 'a%20b', '<script>', 'ünïcode', 'a'.repeat(31)];
    for (const raw of junk) {
        const { store } = loadStore({ launched: true, search: '?c=' + encodeURIComponent(raw) });
        if (store.sourceToken() !== '') problems.push(`'${raw}' survived as '${store.sourceToken()}'`);
        if (store.campaign('web_press') !== 'web_press') {
            problems.push(`'${raw}' produced campaign '${store.campaign('web_press')}'`);
        }
    }
    return problems;
})());

check('valid tokens are accepted, and case is normalised', (() => {
    const problems = [];
    const cases = [
        ['en_macstories', 'en_macstories'],
        ['EN_MacStories', 'en_macstories'],  // ASC groups by exact string; case must not fork a campaign
        ['yt_9to5', 'yt_9to5'],
        ['a', 'a'],
        ['a'.repeat(30), 'a'.repeat(30)]
    ];
    for (const [raw, expected] of cases) {
        const { store } = loadStore({ launched: true, search: '?c=' + raw });
        const got = store.sourceToken();
        if (got !== expected) problems.push(`?c=${raw} produced token '${got}', expected '${expected}'`);
    }
    return problems;
})());

/* ---------- 4. App Store Connect's own limits ---------- */

// ASC caps ct at 40 characters. Over that, names truncate — and two outlets
// truncated to the same string merge into one campaign that looks real.
check('no campaign name can exceed the 40-character ct limit', (() => {
    const problems = [];
    const longest = 'a'.repeat(30);
    const { store } = loadStore({ launched: true, search: '?c=' + longest });
    const name = store.campaign('web_press');
    if (name.length > 40) problems.push(`web_press + a max-length token is ${name.length} characters`);
    if (name.length !== 40) {
        // Not a failure in itself, but the token cap was chosen to land exactly
        // here; if it drifts, the comment in appstore.js is now a lie.
        problems.push(`expected the cap to land exactly on 40 characters, got ${name.length} — is MAX_TOKEN_LENGTH still 30?`);
    }
    return problems;
})());

/* ---------- 5. pt= — the gate that silently costs everything ---------- */

check('pt= is attached once a real provider token is set', (() => {
    const problems = [];
    const { store } = loadStore({ launched: true, providerToken: LIVE_TOKEN });
    const link = store.url('web_home');
    if (!link.includes('pt=' + LIVE_TOKEN)) problems.push(`no pt= in ${link}`);
    if (!link.includes('ct=web_home')) problems.push(`no ct= in ${link}`);
    if (!link.includes('mt=8')) problems.push(`no mt=8 in ${link}`);
    if (!link.startsWith('https://apps.apple.com/app/id')) problems.push(`unexpected host: ${link}`);
    if (!store.attributionReady()) problems.push('attributionReady() is false with a numeric provider token');
    return problems;
})());

check('a missing provider token degrades the link but is not silent', (() => {
    const problems = [];
    const { store, warnings } = loadStore({ launched: true, providerToken: 'PROVIDER_TOKEN' });
    const link = store.url('web_home');

    // The download must still work. Analytics is never worth a broken link.
    if (link === null) problems.push('url() returned null with an unset provider token — the link should still work');
    if (link && link.includes('pt=')) problems.push('pt= was attached from a placeholder value');
    if (store.attributionReady()) problems.push('attributionReady() is true with a placeholder token');

    // But it must say so, because nothing else will.
    if (warnings.length === 0) problems.push('no console warning when live but unattributed');
    if (warnings.length > 1) problems.push(`warned ${warnings.length} times — the warning should fire once, not per link`);

    const quiet = loadStore({ launched: true, providerToken: LIVE_TOKEN });
    quiet.store.url('web_home');
    if (quiet.warnings.length) problems.push('warned even though attribution is correctly configured');
    return problems;
})());

/* ---------- 6. wireLinks stays opt-in ---------- */

check('wireLinks tags hrefs, and only folds the token in when asked', (() => {
    const problems = [];
    const anchor = () => ({
        tagName: 'A',
        href: '#',
        getAttribute: () => 'web_press'
    });

    const withToken = loadStore({
        launched: true, providerToken: LIVE_TOKEN, search: '?c=en_macstories', links: [anchor()]
    });
    const a = withToken.document.querySelectorAll()[0];
    withToken.store.wireLinks(withToken.document, { sourceToken: true });
    if (!a.href.includes('ct=web_press_en_macstories')) problems.push(`opt-in wiring produced ${a.href}`);

    const without = loadStore({
        launched: true, providerToken: LIVE_TOKEN, search: '?c=en_macstories', links: [anchor()]
    });
    const b = without.document.querySelectorAll()[0];
    without.store.wireLinks(without.document);
    if (!b.href.includes('ct=web_press&') && !b.href.endsWith('ct=web_press')) {
        problems.push(`default wiring should ignore ?c=, produced ${b.href}`);
    }

    // A "Coming soon" span carries the attribute before it becomes a link.
    const span = { tagName: 'SPAN', getAttribute: () => 'web_home' };
    const spans = loadStore({ launched: true, providerToken: LIVE_TOKEN, links: [span] });
    spans.store.wireLinks(spans.document);
    if ('href' in span) problems.push('wireLinks set an href on a non-anchor');
    return problems;
})());

/* ---------- 7. /join must never leak invite codes into campaigns ---------- */

// /join reads ?c= too, but there it is a group invite code. Folding that into a
// campaign name would mint an ASC campaign per group ever created and publish
// private codes into a dashboard. This is a source check because the mistake
// would be made by editing join/index.html, not by calling the API wrong.
check('/join collapses its ?c= to a fixed campaign, never a name', (() => {
    const problems = [];
    const joinHtml = fs.readFileSync(path.join(ROOT, 'join/index.html'), 'utf8');

    if (/CCStore\.campaign\s*\(/.test(joinHtml)) {
        problems.push('join/index.html calls CCStore.campaign() — its ?c= is an invite code, not a source token');
    }
    if (/sourceToken\s*:\s*true/.test(joinHtml)) {
        problems.push('join/index.html opts into source-token wiring — that would publish invite codes to ASC');
    }

    // The campaign it does use must be one of two fixed strings.
    const assignments = [...joinHtml.matchAll(/CC_JOIN_CAMPAIGN\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    if (assignments.length === 0) {
        problems.push('could not find the CC_JOIN_CAMPAIGN assignment — this check can no longer be trusted');
    }
    for (const expr of assignments) {
        const literals = [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
        const nonLiteral = expr.replace(/'[^']*'/g, '').replace(/[\s?:]/g, '');
        if (literals.length !== 2 || !literals.includes('web_join_invite') || !literals.includes('web_join_direct')) {
            problems.push(`CC_JOIN_CAMPAIGN is built from ${JSON.stringify(literals)} — expected exactly the two fixed names`);
        }
        // Anything left over after removing the two literals and the ternary
        // punctuation is a variable feeding the campaign name — e.g. the code.
        if (nonLiteral !== 'hasCode') {
            problems.push(`CC_JOIN_CAMPAIGN depends on '${nonLiteral}' — only the hasCode boolean may decide it`);
        }
    }
    return problems;
})());

/* ---------- 8. every campaign name on the site is a documented one ---------- */

// ASC groups by exact string, so 'web-press' and 'web_press' are two campaigns
// and neither is wrong at runtime. The header comment in appstore.js is the
// list; this makes it binding.
check('every campaign name used on the site is documented in appstore.js', (() => {
    const documented = new Set(
        [...APPSTORE_SRC.matchAll(/^ \*   ([a-z][a-z0-9_]*)\s{2,}\S/gm)].map((m) => m[1])
    );
    if (documented.size === 0) {
        return ['could not parse the CAMPAIGN NAMES block in appstore.js — this check cannot be trusted'];
    }

    const problems = [];
    const pages = ['index.html', 'press/index.html', 'join/index.html'];
    for (const page of pages) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const used = [
            ...[...html.matchAll(/data-cc-campaign="([^"]+)"/g)].map((m) => m[1]),
            ...[...html.matchAll(/campaign\s*:\s*'([^']+)'/g)].map((m) => m[1]),
            ...[...html.matchAll(/CCStore\.campaign\('([^']+)'\)/g)].map((m) => m[1]),
            ...[...html.matchAll(/CC_JOIN_CAMPAIGN\s*=[^;]*?'([^']+)'\s*:\s*'([^']+)'/g)].flatMap((m) => [m[1], m[2]])
        ];
        for (const name of used) {
            if (!documented.has(name)) {
                problems.push(`${page} uses campaign '${name}', which is not in the CAMPAIGN NAMES list in appstore.js`);
            }
        }
    }
    return problems;
})());

/* ---------- 9. the press page has to actually ask for the token ---------- */

// Everything above tests the API. None of it notices if press/index.html goes
// back to a bare `campaign: 'web_press'` — which is exactly the state this file
// was written to fix, and it passed every other check in here.
check('the press page tokenises its own campaign', (() => {
    const problems = [];
    const pressHtml = fs.readFileSync(path.join(ROOT, 'press/index.html'), 'utf8');

    const banner = pressHtml.match(/CCStore\.smartBanner\(\{([^}]*)\}\)/);
    if (!banner) {
        return ['could not find the CCStore.smartBanner call in press/index.html — this check cannot be trusted'];
    }
    if (!/campaign\s*:\s*CCStore\.campaign\('web_press'\)/.test(banner[1])) {
        problems.push(`the press banner campaign is not tokenised: ${banner[1].trim()}`);
    }
    if (/campaign\s*:\s*'web_press'/.test(banner[1])) {
        problems.push("the press banner is back to a bare 'web_press' — every outlet reports as one number");
    }
    if (!/CCStore\.wireLinks\([^)]*sourceToken\s*:\s*true[^)]*\)/.test(pressHtml)) {
        problems.push('press/index.html does not opt into source-token link wiring, so a future CTA would ship untagged');
    }
    return problems;
})());

/* ---------- 10. the real press tokens, when they're reachable ---------- */

// outreach.json lives in the app repo, so this is a local cross-check that
// skips rather than fails when the sibling checkout isn't there. It catches the
// one mistake the synthetic tests above cannot: a token added to the press list
// in a shape this site silently refuses, e.g. a hyphen instead of underscore.
(() => {
    const outreach = path.join(ROOT, '..', 'cardioclowns2', 'marketing', 'press', 'outreach.json');
    if (!fs.existsSync(outreach)) {
        console.log('  skip  real press tokens survive ?c= (app repo not checked out alongside)');
        return;
    }
    check('every real press token survives ?c= unchanged', (() => {
        const data = JSON.parse(fs.readFileSync(outreach, 'utf8'));
        const problems = [];
        for (const target of data.targets) {
            const { store } = loadStore({ launched: true, search: '?c=' + target.token });
            if (store.sourceToken() !== target.token) {
                problems.push(`token '${target.token}' (${target.outlet}) is dropped — that pitch would report as plain web_press`);
            }
            const name = store.campaign('web_press');
            if (name.length > 40) problems.push(`'${name}' is ${name.length} characters, over the ct limit`);
        }
        return problems;
    })());
})();

/* ---------- summary ---------- */

console.log();
if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed`);
    process.exit(1);
}
console.log(`all ${checks} checks passed`);

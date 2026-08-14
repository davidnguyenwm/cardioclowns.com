/*
 * The Smart App Banner, end to end. Run: node tests/smart-app-banner.test.js
 *
 * WHY THIS EXISTS
 *
 * The banner is the invite funnel's last mile: someone gets a link, opens it in
 * Safari without the app, and the strip at the top of the page is what carries
 * them to the App Store and then back into the app *with their group code still
 * attached*. When it works the invitee never types anything. When it doesn't,
 * they land on a page telling them to enter a code they no longer have.
 *
 * None of that can be exercised before launch — there is no app to install —
 * and the parts that decide whether it will work are all invisible:
 *
 *   1. Safari builds the banner from the `apple-itunes-app` meta tag it sees
 *      *while parsing the head*. /join has no static tag; it writes one from
 *      JavaScript. That is fine only because the script is inline in the head
 *      and synchronous. Move it to the end of the body, add `defer` to the
 *      appstore.js tag, or wrap the call in a DOMContentLoaded listener, and
 *      the meta lands after Safari has already decided there is no banner.
 *      The page still renders perfectly. The tag is still in the DOM. The
 *      banner is simply never shown, and nothing anywhere says so.
 *   2. The banner block runs before `<body>` exists. Anything reaching for an
 *      element throws, and takes the banner and the analytics with it.
 *   3. The app id is written in two places — appstore.js and index.html — and
 *      a banner carrying the wrong number sends invitees to another app.
 *   4. `app-argument` is the URL the app is opened with. If it stops carrying
 *      the code, the install works, the app opens, and the invitee is not in
 *      the group. That is the failure that looks like success.
 *
 * The end-to-end walkthrough this file replaces (Safari → banner → install →
 * Open → auto-join) can only be done once the app is on sale. These are the
 * parts that can be pinned down today, so that walkthrough is a confirmation
 * rather than a first attempt.
 *
 * The other half of the hand-off — that the app actually accepts the
 * app-argument this file checks — is in tests/invite-contract.test.js, and in
 * InviteLinkTests.swift in the app repo.
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
    if (!Array.isArray(problems)) {
        console.error(`\n${name}: check() expected an array of problems, got ${typeof problems}.`);
        process.exit(1);
    }
    if (problems.length === 0) {
        console.log(`  ok    ${name}`);
        return;
    }
    failures++;
    console.log(`  FAIL  ${name}`);
    for (const p of problems) console.log(`          ${p}`);
}

const APPSTORE_SRC = fs.readFileSync(path.join(ROOT, 'appstore.js'), 'utf8');
const JOIN_HTML = fs.readFileSync(path.join(ROOT, 'join/index.html'), 'utf8');
const HOME_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** A declaration's value out of appstore.js, or a hard stop if it moved. */
function declared(name) {
    const m = APPSTORE_SRC.match(new RegExp(`var ${name} = '([^']*)';`));
    if (!m) {
        console.error(`Could not read \`${name}\` out of appstore.js — the declaration changed shape.`);
        process.exit(1);
    }
    return m[1];
}

const APP_STORE_ID = declared('APP_STORE_ID');

/** The banner's field list, split the way a browser splits it — on every
 *  comma, not on ', '. An injected field carries no space. */
function bannerFields(content) {
    return content.split(',').map((field) => {
        const trimmed = field.trim();
        const at = trimmed.indexOf('=');
        return at === -1 ? [trimmed, ''] : [trimmed.slice(0, at), trimmed.slice(at + 1)];
    });
}

/** Where `</head>` ends, so "is this in the head" is a character offset
 *  question rather than a guess about indentation. */
function headEnd(html, file) {
    const at = html.indexOf('</head>');
    if (at === -1) {
        console.error(`${file} has no </head>.`);
        process.exit(1);
    }
    return at;
}

const JOIN_HEAD_END = headEnd(JOIN_HTML, 'join/index.html');
const HOME_HEAD_END = headEnd(HOME_HTML, 'index.html');

/** The join page's Smart App Banner block, taken from the shipped page. */
const BANNER_SCRIPT = (() => {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(JOIN_HTML)) !== null) {
        if (/CCStore\.smartBanner\(/.test(m[1])) return { source: m[1], at: m.index };
    }
    console.error('No inline script in join/index.html calls CCStore.smartBanner().');
    process.exit(1);
})();

console.log(
    `app id ${APP_STORE_ID} · LAUNCHED=${/var LAUNCHED = true;/.test(APPSTORE_SRC)}\n`
);

/* ---------- 1. one app id, everywhere it is written ---------- */

// The checklist item this file exists for begins "needs the live numeric App
// Store ID in both HTML files". It is in both — as a literal in one and via
// appstore.js in the other — and nothing until now compared them. Two numbers
// that are supposed to be one number is exactly the shape of bug that ships:
// the banner still appears, it just installs a different app.
check('the App Store id is the same number everywhere it is written', (() => {
    const problems = [];
    if (!/^[0-9]+$/.test(APP_STORE_ID)) {
        problems.push(`appstore.js APP_STORE_ID is '${APP_STORE_ID}', which is not a numeric id`);
    }

    // Any page that hand-writes a banner has to agree with the one place the
    // number is supposed to live.
    const pages = fs.readdirSync(ROOT, { withFileTypes: true })
        .flatMap((entry) => {
            if (entry.isFile() && entry.name.endsWith('.html')) return [entry.name];
            if (!entry.isDirectory() || entry.name.startsWith('.')) return [];
            const nested = path.join(ROOT, entry.name, 'index.html');
            return fs.existsSync(nested) ? [path.join(entry.name, 'index.html')] : [];
        });

    let staticBanners = 0;
    for (const page of pages) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const metas = [...html.matchAll(/<meta\s+name="apple-itunes-app"\s+content="([^"]*)"/g)];
        for (const [, content] of metas) {
            staticBanners++;
            const fields = new Map(bannerFields(content));
            if (fields.get('app-id') !== APP_STORE_ID) {
                problems.push(
                    `${page} hand-writes app-id=${fields.get('app-id')}, ` +
                    `but appstore.js says ${APP_STORE_ID}`
                );
            }
        }
    }
    if (staticBanners === 0) {
        problems.push('no page ships a static banner meta — index.html\'s no-JS fallback is gone');
    }
    return problems;
})());

/* ---------- 2. Safari has to see the tag during the head parse ---------- */

/*
 * This is the check that the whole file is for.
 *
 * Safari decides whether a page has a Smart App Banner while it parses the
 * head. /join ships no static tag — it cannot, because the tag has to carry
 * the group code from the URL — so the tag is written by script, and it counts
 * only because that script is inline in the head and runs synchronously.
 *
 * Every plausible tidy-up breaks it silently: moving the block to the end of
 * the body next to the other scripts, adding `defer` to the appstore.js tag so
 * it "doesn't block rendering", or wrapping the call in a DOMContentLoaded
 * handler the way the rest of the site does. In all three the page looks
 * perfect, the meta tag is present if you inspect the DOM, and no invitee ever
 * sees a banner again.
 */
check('Safari sees the join page banner while it is still parsing the head', (() => {
    const problems = [];

    const appstoreTag = JOIN_HTML.match(/<script[^>]*\bsrc="\/appstore\.js"[^>]*>/);
    if (!appstoreTag) return ['join/index.html does not load /appstore.js at all'];

    if (appstoreTag.index > JOIN_HEAD_END) {
        problems.push('/appstore.js is loaded after </head> — the banner is written too late to render');
    }
    if (/\bdefer\b|\basync\b/.test(appstoreTag[0])) {
        problems.push(`the /appstore.js tag is ${appstoreTag[0]} — deferring it moves the banner past the head parse`);
    }
    if (BANNER_SCRIPT.at > JOIN_HEAD_END) {
        problems.push('the smartBanner() block sits after </head> — Safari has already decided there is no banner');
    }
    if (BANNER_SCRIPT.at < appstoreTag.index) {
        problems.push('the smartBanner() block runs before /appstore.js loads, so CCStore is undefined');
    }

    // Same failure, reached by deferring the call rather than the file.
    for (const deferral of ['DOMContentLoaded', 'window.onload', 'requestAnimationFrame', 'setTimeout']) {
        if (BANNER_SCRIPT.source.includes(deferral)) {
            problems.push(`the banner block defers through ${deferral} — the tag lands after the head parse`);
        }
    }
    return problems;
})());

/*
 * Running in the head means running before there is a body. The suite that
 * covers this page hands the banner block a fully built DOM, because the render
 * block that follows it needs one — so a `document.getElementById(...)` added
 * to the banner block would pass there and throw in Safari, killing the banner
 * and every line of script after it on the page.
 *
 * This runs the same block under the conditions it actually meets: no body, no
 * elements, nothing but a head to append to.
 */
check('the join page banner block runs before the body exists', (() => {
    const problems = [];
    const search = '?code=CLWNS7&ref=abc12345&sid=deadbeef';

    const appended = [];
    const document = {
        // What the DOM really holds at this point in the parse.
        body: null,
        head: { appendChild(node) { appended.push(node); } },
        getElementById() { return null; },
        querySelector(sel) {
            if (sel !== 'meta[name="apple-itunes-app"]') return null;
            return appended.find((n) => n.name === 'apple-itunes-app') || null;
        },
        querySelectorAll() { return []; },
        createElement() { return { name: '', content: '' }; }
    };

    const context = vm.createContext({});
    vm.runInContext('var window = this;', context);
    Object.assign(context, {
        document,
        location: {
            search,
            pathname: '/join/',
            href: 'https://cardioclowns.com/join/' + search
        },
        URLSearchParams,
        console: { warn() {}, log() {} }
    });

    const launched = APPSTORE_SRC.replace(/var LAUNCHED = false;/, 'var LAUNCHED = true;');
    if (launched === APPSTORE_SRC) return ['could not patch LAUNCHED — the declaration changed shape'];

    try {
        vm.runInContext(launched, context, { filename: 'appstore.js' });
        vm.runInContext(BANNER_SCRIPT.source, context, { filename: 'join:banner' });
    } catch (e) {
        return [`the banner block threw with no body in the document: ${e.message}`];
    }

    const meta = appended.find((n) => n.name === 'apple-itunes-app');
    if (!meta) problems.push('no banner was written during the head parse');
    return problems;
})());

/*
 * The homepage takes the other route, and has to keep taking it: its
 * smartBanner() call sits at the end of the body with the rest of the page
 * wiring, far past the head parse, so the tag Safari actually renders is the
 * static one in the markup. Delete that tag as "the JS writes it anyway" and
 * the homepage silently loses its banner.
 */
check('the homepage keeps the static tag its own script is too late to replace', (() => {
    const problems = [];
    const meta = HOME_HTML.match(/<meta\s+name="apple-itunes-app"\s+content="([^"]*)"/);
    if (!meta) return ['index.html has no static apple-itunes-app tag, and writes its banner after </head>'];
    if (meta.index > HOME_HEAD_END) problems.push('the static banner tag is outside the head');

    if (HOME_HTML.indexOf('CCStore.smartBanner(') === -1) {
        problems.push('index.html no longer wires the banner through appstore.js');
    }

    const fields = new Map(bannerFields(meta[1]));
    for (const [name] of fields) {
        if (name !== 'app-id') {
            problems.push(`the static tag carries '${name}' — it can only safely carry app-id`);
        }
    }
    return problems;
})());

/* ---------- 3. what the banner hands the app ---------- */

/**
 * The banner the join page writes for a given invite URL, post-launch.
 * Deliberately built by running the shipped page's own block rather than by
 * re-deriving the content here — a re-derivation would test itself.
 */
function bannerFor(search, options = {}) {
    const appended = [];
    const document = {
        body: null,
        head: { appendChild(node) { appended.push(node); } },
        getElementById() { return null; },
        querySelector(sel) {
            if (sel !== 'meta[name="apple-itunes-app"]') return null;
            return appended.find((n) => n.name === 'apple-itunes-app') || null;
        },
        querySelectorAll() { return []; },
        createElement() { return { name: '', content: '' }; }
    };
    let src = APPSTORE_SRC.replace(/var LAUNCHED = false;/, 'var LAUNCHED = true;');
    if (options.providerToken) {
        src = src.replace(/var PROVIDER_TOKEN = '[^']*';/, `var PROVIDER_TOKEN = '${options.providerToken}';`);
    }
    const context = vm.createContext({});
    vm.runInContext('var window = this;', context);
    Object.assign(context, {
        document,
        location: { search, pathname: '/join/', href: 'https://cardioclowns.com/join/' + search },
        URLSearchParams,
        console: { warn() {}, log() {} }
    });
    vm.runInContext(src, context, { filename: 'appstore.js' });
    vm.runInContext(BANNER_SCRIPT.source, context, { filename: 'join:banner' });
    const meta = appended.find((n) => n.name === 'apple-itunes-app');
    return meta ? new Map(bannerFields(meta.content)) : null;
}

/** The alphabet and length the page itself validates a code against, so this
 *  file cannot drift into accepting a code shape the page rejects. */
const CODE_PATTERN = (() => {
    const m = JOIN_HTML.match(/\/\^\[([^\]]+)\]\{(\d+)\}\$\//);
    if (!m) {
        console.error('Could not find the code-validation regex in join/index.html.');
        process.exit(1);
    }
    return new RegExp(`^[${m[1]}]{${m[2]}}$`);
})();

/*
 * "The app receives the URL with the code and auto-joins" is the half of the
 * walkthrough that fails without a symptom: the install succeeds, the app
 * opens, and the invitee is simply not in a group. It comes down to one string.
 */
check('the banner hands the app a link that still carries the group code', (() => {
    const problems = [];
    const fields = bannerFor('?code=CLWNS7&ref=abc12345&sid=deadbeef&lang=pt-BR', { providerToken: '123456789' });
    if (!fields) return ['no banner was written after launch'];

    const argument = fields.get('app-argument') || '';
    let url;
    try {
        url = new URL(argument);
    } catch (e) {
        return [`app-argument is not a URL at all: '${argument}'`];
    }

    if (url.protocol !== 'https:') problems.push(`app-argument is ${url.protocol}, and iOS only hands over https`);
    if (url.hostname !== 'cardioclowns.com') {
        problems.push(`app-argument points at ${url.hostname}, which the app's associated domain does not cover`);
    }
    // The AASA covers /join and /join/*; anything else is a link the app is
    // never offered and the invitee lands back on the web page.
    if (!(url.pathname === '/join' || url.pathname.startsWith('/join/'))) {
        problems.push(`app-argument path is '${url.pathname}', outside the /join paths the AASA claims`);
    }

    const code = (url.searchParams.get('code') || url.searchParams.get('c') || '').toUpperCase();
    if (!CODE_PATTERN.test(code)) {
        problems.push(`app-argument carries no usable group code — the app opens on an empty join: '${argument}'`);
    }
    // Attribution rides the same string; losing it is silent and unbackfillable.
    if (url.searchParams.get('sid') !== 'deadbeef') {
        problems.push(`app-argument lost the share id: '${argument}'`);
    }
    if (url.searchParams.get('ref') !== 'abc12345') {
        problems.push(`app-argument lost the inviter ref: '${argument}'`);
    }

    return problems;
})());

/*
 * A literal comma in app-argument is not a mangled argument, it is a new banner
 * field — the invite URL is attacker-supplied and `,app-id=999999999` retargets
 * the install. appArgument() in appstore.js encodes commas to %2C rather than
 * dropping the argument, so the door closes without costing the invitee their
 * deep link.
 *
 * That trade only holds because %2C survives the round trip: iOS hands the app
 * the string verbatim, and URLComponents decodes it back on the way in. Checked
 * against the app's real parser in InviteLinkTests.swift — the assertion here
 * is the encoding half, and it needs a URL that actually contains a comma to
 * mean anything.
 */
check('a comma in the invite URL is encoded, not passed through or dropped', (() => {
    const problems = [];
    const cases = [
        '?code=CLWNS7&x=,app-id=999999999',
        '?code=CLWNS7&x=,app-argument=https://evil.example',
        '?code=CLWNS7&ref=abc12345,x&sid=deadbeef'
    ];
    for (const search of cases) {
        const fields = bannerFor(search);
        if (!fields) { problems.push(`${search}: no banner written`); continue; }
        const argument = fields.get('app-argument') || '';
        if (!argument) {
            problems.push(`${search}: app-argument was dropped, so the invitee opens the app with no code`);
            continue;
        }
        if (argument.includes(',')) {
            problems.push(`${search}: a raw comma survived into app-argument, opening a second banner field: '${argument}'`);
        }
        if (!argument.includes('%2C')) {
            problems.push(`${search}: the comma vanished rather than being encoded: '${argument}'`);
        }
        // The point of encoding rather than dropping: the code still arrives.
        let code = '';
        try {
            code = (new URL(argument).searchParams.get('code') || '').toUpperCase();
        } catch (e) {
            problems.push(`${search}: app-argument is not a URL: '${argument}'`);
            continue;
        }
        if (code !== 'CLWNS7') problems.push(`${search}: sanitising cost the group code, got '${code}'`);
    }
    return problems;
})());

/*
 * A code the invitee can read on the page but the banner does not carry is
 * worse than no banner: they install, tap Open, and land in the app with
 * nothing, having been told the code was already handled.
 */
check('every link shape the page accepts reaches the app through the banner', (() => {
    const problems = [];
    const shapes = [
        '?code=CLWNS7',
        '?c=CLWNS7',
        '?code=clwns7',
        '?code=CLWNS7&lang=de',
        '?code=CLWNS7&ref=abc12345&sid=deadbeef'
    ];
    for (const search of shapes) {
        const fields = bannerFor(search);
        if (!fields) { problems.push(`${search}: no banner written`); continue; }
        const argument = fields.get('app-argument') || '';
        let code = '';
        try {
            const url = new URL(argument);
            code = (url.searchParams.get('code') || url.searchParams.get('c') || '').toUpperCase();
        } catch (e) {
            problems.push(`${search}: app-argument is not a URL: '${argument}'`);
            continue;
        }
        if (code !== 'CLWNS7') {
            problems.push(`${search}: the app would open on code '${code}' instead of CLWNS7`);
        }
    }
    return problems;
})());

/*
 * The banner is only the App Clip card because of these two fields, and the
 * card is what a visitor without the app is actually offered. Losing them
 * downgrades the invite to a plain App Store link — still works, but the
 * instant-preview path the clip exists for is gone, and nothing reports it.
 */
check('a visitor without the app is offered the App Clip card', (() => {
    const problems = [];
    const fields = bannerFor('?code=CLWNS7');
    if (!fields) return ['no banner was written after launch'];
    if (fields.get('app-id') !== APP_STORE_ID) {
        problems.push(`banner app-id is '${fields.get('app-id')}', expected ${APP_STORE_ID}`);
    }
    if (fields.get('app-clip-display') !== 'card') {
        problems.push(`app-clip-display is '${fields.get('app-clip-display')}', so no clip card is shown`);
    }
    if (fields.get('app-clip-bundle-id') !== 'com.davidnguyen.Cardio-Clowns.Clip') {
        problems.push(`app-clip-bundle-id is '${fields.get('app-clip-bundle-id')}'`);
    }
    return problems;
})());

/* ---------- 4. and none of it before there is an app to install ---------- */

check('before launch the join page offers no banner at all', (() => {
    const problems = [];
    const appended = [];
    const document = {
        body: null,
        head: { appendChild(node) { appended.push(node); } },
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { name: '', content: '' }; }
    };
    const context = vm.createContext({});
    vm.runInContext('var window = this;', context);
    Object.assign(context, {
        document,
        location: { search: '?code=CLWNS7', pathname: '/join/', href: 'https://cardioclowns.com/join/?code=CLWNS7' },
        URLSearchParams,
        console: { warn() {}, log() {} }
    });
    // The shipped file, unpatched — whatever it actually does today.
    vm.runInContext(APPSTORE_SRC, context, { filename: 'appstore.js' });
    vm.runInContext(BANNER_SCRIPT.source, context, { filename: 'join:banner' });

    const launched = /var LAUNCHED = true;/.test(APPSTORE_SRC);
    if (!launched && appended.length) {
        problems.push('a banner was written while LAUNCHED is false — it would point at an app that is not on sale');
    }
    if (launched && !appended.length) {
        problems.push('LAUNCHED is true but the join page wrote no banner');
    }
    return problems;
})());

console.log();
if (failures) {
    console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
    process.exit(1);
}
console.log(`\x1b[32mall ${checks} checks passed\x1b[0m`);

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

/** Every page on the site, as a path relative to the repo root. */
function everyPage() {
    return fs.readdirSync(ROOT, { withFileTypes: true })
        .flatMap((entry) => {
            if (entry.isFile() && entry.name.endsWith('.html')) return [entry.name];
            if (!entry.isDirectory() || entry.name.startsWith('.')) return [];
            const nested = path.join(ROOT, entry.name, 'index.html');
            return fs.existsSync(nested) ? [path.join(entry.name, 'index.html')] : [];
        })
        .sort();
}

/** The inline script that writes a page's Smart App Banner, or null. Found by
 *  what it does rather than by where it sits, so moving it is visible to the
 *  placement checks below instead of making it disappear from them. */
function bannerBlock(html) {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (/CCStore\.smartBanner\(/.test(m[1])) return { source: m[1], at: m.index };
    }
    return null;
}

/** The pages that write a banner at all, with everything needed to judge when. */
const BANNER_PAGES = everyPage()
    .map((page) => {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const block = bannerBlock(html);
        return block ? { page, html, block, headEnd: headEnd(html, page) } : null;
    })
    .filter(Boolean);

if (BANNER_PAGES.length === 0) {
    console.error('No page on the site writes a Smart App Banner.');
    process.exit(1);
}

/** The join page's block, which is the one carrying real parsing logic. */
const BANNER_SCRIPT = (() => {
    const block = bannerBlock(JOIN_HTML);
    if (!block) {
        console.error('No inline script in join/index.html calls CCStore.smartBanner().');
        process.exit(1);
    }
    return block;
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
 * head. Every page here writes its tag from script — /join has to, because the
 * tag carries the group code out of the URL — and that counts only because the
 * script is inline in the head and runs synchronously.
 *
 * Every plausible tidy-up breaks it silently: moving the block to the end of
 * the body next to the other page wiring, adding `defer` to the appstore.js tag
 * so it "doesn't block rendering", or wrapping the call in a DOMContentLoaded
 * handler the way the rest of the site does. In all three the page looks
 * perfect, the meta tag is present if you inspect the DOM, and nobody is ever
 * shown a banner.
 *
 * Two pages shipped that way and this is what found them: /press wrote its
 * banner from the end of the body with no static tag to fall back on, so it had
 * no banner at all — on the page every one of the press pitches links to. The
 * homepage did the same, but survived on its static tag, silently losing the
 * affiliate-data that carries pt/ct.
 */
check('every page writes its Smart App Banner during the head parse', (() => {
    const problems = [];
    for (const { page, html, block, headEnd: end } of BANNER_PAGES) {
        const appstoreTag = html.match(/<script[^>]*\bsrc="\/appstore\.js"[^>]*>/);
        if (!appstoreTag) {
            problems.push(`${page} calls smartBanner() but never loads /appstore.js`);
            continue;
        }
        if (appstoreTag.index > end) {
            problems.push(`${page}: /appstore.js is loaded after </head> — the banner is written too late to render`);
        }
        if (/\bdefer\b|\basync\b/.test(appstoreTag[0])) {
            problems.push(`${page}: the /appstore.js tag is ${appstoreTag[0]} — deferring it moves the banner past the head parse`);
        }
        if (block.at > end) {
            problems.push(`${page}: the smartBanner() block sits after </head> — Safari has already decided there is no banner`);
        }
        if (block.at < appstoreTag.index) {
            problems.push(`${page}: the smartBanner() block runs before /appstore.js loads, so CCStore is undefined`);
        }
        // Same failure, reached by deferring the call rather than the file.
        for (const deferral of ['DOMContentLoaded', 'window.onload', 'requestAnimationFrame', 'setTimeout']) {
            if (block.source.includes(deferral)) {
                problems.push(`${page}: the banner block defers through ${deferral} — the tag lands after the head parse`);
            }
        }
    }
    return problems;
})());

/*
 * The mirror image, and the reason the banner call could not simply be moved
 * wholesale: wireLinks walks `[data-cc-campaign]` elements to turn the
 * "Coming soon" placeholders into real download links. Run it in the head and
 * it matches nothing — no error, no banner-shaped symptom, just CTAs that stay
 * inert on the day they are supposed to start selling the app.
 */
check('wireLinks runs late enough to find the elements it wires', (() => {
    const problems = [];
    for (const page of everyPage()) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const at = html.indexOf('CCStore.wireLinks(');
        if (at === -1) continue;
        if (at < headEnd(html, page)) {
            problems.push(`${page}: wireLinks runs in the head, before any [data-cc-campaign] element exists`);
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
check('every banner block runs before the body exists', (() => {
    const problems = [];
    if (!/var LAUNCHED = (?:false|true);/.test(APPSTORE_SRC)) {
        return ['could not patch LAUNCHED — the declaration changed shape'];
    }
    const launched = APPSTORE_SRC.replace(/var LAUNCHED = (?:false|true);/, 'var LAUNCHED = true;');

    for (const { page, html, block } of BANNER_PAGES) {
        // /join is the page whose banner varies with the URL, so it is the one
        // given a real invite; the rest only need somewhere to append to.
        const pathname = '/' + path.dirname(page).replace(/^\.$/, '') + (page.includes('/') ? '/' : '');
        const search = page.startsWith('join/') ? '?code=CLWNS7&ref=abc12345&sid=deadbeef' : '';

        const appended = [];
        // A static tag already in the markup is part of the starting state:
        // smartBanner() rewrites it rather than appending a second one, and a
        // page that has one must still end up with exactly one.
        const staticTag = /<meta\s+name="apple-itunes-app"/.test(html)
            ? { name: 'apple-itunes-app', content: 'app-id=' + APP_STORE_ID }
            : null;
        if (staticTag) appended.push(staticTag);

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
            location: { search, pathname, href: 'https://cardioclowns.com' + pathname + search },
            URLSearchParams,
            console: { warn() {}, log() {} }
        });

        try {
            vm.runInContext(launched, context, { filename: 'appstore.js' });
            vm.runInContext(block.source, context, { filename: `${page}:banner` });
        } catch (e) {
            problems.push(`${page}: the banner block threw with no body in the document: ${e.message}`);
            continue;
        }

        const metas = appended.filter((n) => n.name === 'apple-itunes-app');
        if (metas.length === 0) problems.push(`${page}: no banner was written during the head parse`);
        // Two tags is not twice the banner — Safari takes one and the other is
        // dead weight carrying a different campaign.
        if (metas.length > 1) {
            problems.push(`${page}: ${metas.length} apple-itunes-app tags after the head parse, expected 1`);
        }
        if (metas.length === 1 && !metas[0].content.includes('app-id=' + APP_STORE_ID)) {
            problems.push(`${page}: the banner ended up as '${metas[0].content}'`);
        }
    }
    return problems;
})());

/*
 * The homepage keeps a static tag as well, and should: it is the one page whose
 * banner needs nothing out of the URL, so it can have a banner even with the
 * script broken or blocked. smartBanner() rewrites that tag in place to add the
 * campaign attribution rather than appending a second one.
 *
 * It can only ever carry `app-id`. Anything else — an app-argument especially —
 * would be a field written before appstore.js has had the chance to sanitise
 * it, which is the whole class of bug the banner's field list invites.
 */
check('the homepage ships a static banner for the no-script case', (() => {
    const problems = [];
    const meta = HOME_HTML.match(/<meta\s+name="apple-itunes-app"\s+content="([^"]*)"/);
    if (!meta) return ['index.html has no static apple-itunes-app tag to fall back on'];
    if (meta.index > HOME_HEAD_END) problems.push('the static banner tag is outside the head');

    if (HOME_HTML.indexOf('CCStore.smartBanner(') === -1) {
        problems.push('index.html no longer wires the banner through appstore.js, so it never gets a campaign');
    }
    // Rewritten, not duplicated — so the tag has to come before the script that
    // looks for it, or smartBanner() appends a second one and Safari reads the
    // static, unattributed tag instead.
    const call = HOME_HTML.indexOf('CCStore.smartBanner(');
    if (call !== -1 && call < meta.index) {
        problems.push('smartBanner() runs before the static tag is parsed, so it appends a second banner');
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
    let src = APPSTORE_SRC.replace(/var LAUNCHED = (?:false|true);/, 'var LAUNCHED = true;');
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

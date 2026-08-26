/*
 * The invite landing page, end to end. Run: node tests/join.test.js
 *
 * WHY THIS EXISTS
 *
 * /join is the only page on this site that a stranger reaches by accident. Every
 * other page is something someone went looking for; this one arrives in a text
 * message from a friend, is opened once, on a phone, and either produces an
 * install or doesn't. It is also the only page whose entire behaviour comes from
 * the URL it was opened with — the group code, the sender's language, and the
 * campaign split all come out of a string that anyone can edit before pressing
 * send.
 *
 * It had no tests at all. The page's logic lives in two inline <script> blocks
 * that each parse the same URL independently: one to decide the Smart App Banner
 * campaign, one to render the page. Nothing kept them agreeing, and nothing
 * checked that either agreed with the app's own parser in InviteLink.swift — the
 * third copy of the same rules, in a different language, in a different repo.
 *
 * The failures this covers are all silent by construction:
 *
 *   - a code the page accepts and the app rejects (or the reverse) shows the
 *     invitee a code that does not work, with no error anywhere
 *   - a language the app can send that the page has no copy for renders English
 *     to someone who was invited in Japanese
 *   - a `{code}` placeholder missing from one translation drops the code out of
 *     the title for that language only
 *   - the ?c= group code leaking into a campaign name mints an App Store
 *     Connect campaign per group and publishes private invite codes into an
 *     analytics dashboard
 *   - a crafted invite URL injecting a second field into the Smart App Banner
 *     points the invitee at somebody else's app
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
    // A check that hands over anything but an array is a check that cannot
    // fail — `undefined.length` on a function or a promise reads as zero
    // problems and prints ok. Loudly wrong beats quietly green.
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

/** The banner's field list, parsed the way a browser would rather than the way
 *  we would like it to be. Splitting on ', ' instead of ',' would miss exactly
 *  the injection this file exists to catch — `&x=,app-id=999` carries no space. */
function bannerFields(content) {
    return content.split(',').map((field) => {
        const trimmed = field.trim();
        const at = trimmed.indexOf('=');
        return at === -1 ? [trimmed, ''] : [trimmed.slice(0, at), trimmed.slice(at + 1)];
    });
}

const JOIN_HTML = fs.readFileSync(path.join(ROOT, 'join/index.html'), 'utf8');
const APPSTORE_SRC = fs.readFileSync(path.join(ROOT, 'appstore.js'), 'utf8');

/* ---------- pull the page's own scripts out of the page ---------- */

/*
 * The inline blocks, in document order. Taking them from the shipped HTML
 * rather than from a copy is the whole point: a test that re-implements the
 * parser tests the test.
 */
const INLINE_SCRIPTS = (() => {
    const found = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(JOIN_HTML)) !== null) found.push(m[1]);
    if (found.length !== 2) {
        console.error(
            `join/index.html has ${found.length} inline <script> blocks, expected 2 ` +
            '(the Smart App Banner block and the render block). The harness below runs ' +
            'them in order and can no longer tell which is which.'
        );
        process.exit(1);
    }
    return found;
})();

const [BANNER_SCRIPT, RENDER_SCRIPT] = INLINE_SCRIPTS;

/* ---------- a DOM built from the page's own markup ---------- */

/*
 * Elements are created from the ids the page actually ships, with the `hidden`
 * state it ships them in. A hand-written list would keep passing after an id was
 * renamed in the markup — the render script would throw on a null element in the
 * browser and the fake would happily hold the stale id.
 *
 * Only what the two scripts touch is modelled. They read and write textContent,
 * innerHTML, hidden, href and one click listener, and nothing else.
 */
function parseShippedElements(html) {
    const body = html.slice(html.indexOf('<body>'));
    const elements = new Map();
    const re = /<(\w+)([^>]*\sid="([\w-]+)"[^>]*)>/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        const [, tag, attrs, id] = m;
        elements.set(id, {
            tag,
            hidden: /\shidden(\s|$|=)/.test(attrs),
            href: (attrs.match(/\shref="([^"]*)"/) || [])[1]
        });
    }
    return elements;
}

const SHIPPED_ELEMENTS = parseShippedElements(JOIN_HTML);

class El {
    constructor(id, spec) {
        this.id = id;
        this.tagName = (spec.tag || 'div').toUpperCase();
        this.hidden = !!spec.hidden;
        this._text = '';
        this._html = '';
        this.href = spec.href;
        this.listeners = {};
    }

    set textContent(value) { this._text = value; this._html = ''; }
    get textContent() { return this._text; }

    set innerHTML(value) { this._html = value; this._text = ''; }
    get innerHTML() { return this._html; }

    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn(); }
}

class MetaEl {
    constructor() { this.name = ''; this.content = ''; }
}

/**
 * Runs the page's scripts against `url`, and hands back everything they wrote.
 *
 * `launched` patches appstore.js's one launch switch, so post-launch behaviour —
 * the banner, the real download href — is testable today. The patch is verified,
 * not assumed: a reworded declaration that silently stopped matching would turn
 * every post-launch case below into a second copy of the pre-launch cases.
 */
function renderJoin(options = {}) {
    const search = options.search || '';
    const pathname = options.pathname || '/join/';
    const href = 'https://cardioclowns.com' + pathname + search;

    let appstore = APPSTORE_SRC;
    if (options.launched !== undefined) {
        if (!/var LAUNCHED = (?:false|true);/.test(appstore)) {
            throw new Error('could not patch LAUNCHED — declaration changed shape');
        }
        appstore = appstore.replace(
            /var LAUNCHED = (?:false|true);/,
            `var LAUNCHED = ${options.launched === true};`
        );
    }
    if (options.providerToken !== undefined) {
        if (!/var PROVIDER_TOKEN = '[^']*';/.test(appstore)) {
            throw new Error('could not patch PROVIDER_TOKEN — declaration changed shape');
        }
        appstore = appstore.replace(
            /var PROVIDER_TOKEN = '[^']*';/,
            `var PROVIDER_TOKEN = '${options.providerToken}';`
        );
    }

    const els = new Map();
    for (const [id, spec] of SHIPPED_ELEMENTS) els.set(id, new El(id, spec));

    const metas = [];
    const timers = [];
    const selections = [];
    const copied = [];

    const documentElement = { lang: 'en', dir: '' };
    const doc = {
        title: (JOIN_HTML.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
        documentElement,
        head: { appendChild(node) { metas.push(node); } },
        getElementById(id) { return els.get(id) || null; },
        createElement(tag) { return tag === 'meta' ? new MetaEl() : new El('', { tag }); },
        querySelector(sel) {
            if (sel !== 'meta[name="apple-itunes-app"]') return null;
            return metas.find((n) => n.name === 'apple-itunes-app') || null;
        },
        createRange() {
            return { selectNodeContents(node) { this.node = node; } };
        },
        execCommand(command) {
            if (command === 'copy') copied.push(selections.map((s) => s.textContent).join(''));
            return true;
        }
    };

    // A thenable rather than a real Promise, so the whole suite stays
    // synchronous. The page does exactly one thing with the return value —
    // `.then(done)` — so this exercises the same path; only the tick it lands
    // on differs, and nothing on the page depends on that.
    const navigator = options.clipboard === false
        ? {}
        : { clipboard: { writeText: (text) => { copied.push(text); return { then: (fn) => fn() }; } } };

    const context = vm.createContext({});
    // `window` is the global object in a browser, which is what makes
    // appstore.js's `global.CCStore = ...` visible to the page as a bare
    // `CCStore`. Wiring it any other way would make the page's own scripts
    // unable to see the file they depend on.
    vm.runInContext('var window = this;', context);
    Object.assign(context, {
        document: doc,
        location: { search, pathname, href },
        navigator,
        URLSearchParams,
        console: { warn() {}, log() {} },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        getSelection: () => ({
            removeAllRanges() { selections.length = 0; },
            addRange(range) { selections.push(range.node); }
        })
    });

    vm.runInContext(appstore, context, { filename: 'appstore.js' });
    vm.runInContext(BANNER_SCRIPT, context, { filename: 'join:banner' });
    vm.runInContext(RENDER_SCRIPT, context, { filename: 'join:render' });

    const text = (id) => (els.get(id) ? els.get(id)._text : null);
    return {
        context,
        els,
        text,
        title: doc.title,
        lang: documentElement.lang,
        dir: documentElement.dir,
        campaign: context.CC_JOIN_CAMPAIGN,
        banner: metas.find((n) => n.name === 'apple-itunes-app') || null,
        ctaHref: els.get('cta').href,
        codeShown: !els.get('code-block').hidden,
        code: text('code'),
        noCodeShown: !els.get('no-code').hidden,
        timers,
        copied,
        clickCopy: () => els.get('copy').click(),
        runTimers: () => { const due = timers.splice(0); for (const t of due) t.fn(); }
    };
}

// I18N and resolveLang are top-level declarations in the render block, so a
// rendered page exposes them for direct interrogation.
const { I18N, RTL, resolveLang } = renderJoin().context;
const LANGS = Object.keys(I18N);
const COPY_KEYS = Object.keys(I18N.en).sort();

console.log(
    `join/index.html: ${LANGS.length} languages · ${SHIPPED_ELEMENTS.size} identified elements · ` +
    `2 inline scripts\n`
);

/* ---------- 1. reading the code out of the link ---------- */

// The four shapes a real invite can arrive in. joinURL() in the app emits the
// first; the others exist because people retype, shorten and paste links.
check('every documented link shape yields the group code', (() => {
    const problems = [];
    const shapes = [
        ['?code=CLWNS7', '/join/', 'the canonical share-sheet link'],
        ['?c=CLWNS7', '/join/', 'the short form'],
        ['', '/join/CLWNS7', 'a path-segment code'],
        ['', '/join/CLWNS7/', 'a path-segment code with a trailing slash'],
        ['?code=clwns7', '/join/', 'a lowercased code'],
        ['?code=CLWNS7&ref=abc12345&sid=deadbeef&lang=de', '/join/', 'the full link the app builds']
    ];
    for (const [search, pathname, label] of shapes) {
        const page = renderJoin({ search, pathname });
        if (page.code !== 'CLWNS7') problems.push(`${label}: showed '${page.code}', expected CLWNS7`);
        if (!page.codeShown) problems.push(`${label}: the code block stayed hidden`);
        if (page.noCodeShown) problems.push(`${label}: showed the "ask your friend" fallback anyway`);
    }
    return problems;
})());

// The alphabet drops I, O, 0 and 1 — the characters people swap when reading a
// code down the phone. A page that accepted them would show a code that the
// app can never join with.
check('codes outside the app alphabet are refused', (() => {
    const problems = [];
    const bad = {
        'CLWNS0': 'zero',
        'CLWNS1': 'one',
        'CLWNSI': 'letter I',
        'CLWNSO': 'letter O',
        'CLWNS': 'five characters',
        'CLWNS77': 'seven characters',
        'CL-NS7': 'punctuation',
        'CL NS7': 'a space',
        '': 'an empty value'
    };
    for (const [code, why] of Object.entries(bad)) {
        const page = renderJoin({ search: `?code=${encodeURIComponent(code)}` });
        if (page.codeShown) problems.push(`${why} ('${code}') was shown as a usable code`);
        if (!page.noCodeShown) problems.push(`${why} ('${code}') left the invitee with no instructions`);
    }
    return problems;
})());

check('a code is only read from this page\'s own path', (() => {
    const problems = [];
    // A path-segment code is accepted under /join/ and nowhere else. The page is
    // only ever served from /join/, but the same parse decides the banner
    // campaign, and a looser match there would call any URL an invite.
    for (const pathname of ['/joinus/CLWNS7', '/press/CLWNS7', '/CLWNS7']) {
        const page = renderJoin({ pathname });
        if (page.codeShown) problems.push(`${pathname} was read as an invite`);
    }
    // Extra path after the code is not a code.
    if (renderJoin({ pathname: '/join/CLWNS7/extra' }).codeShown) {
        problems.push('/join/CLWNS7/extra was read as an invite');
    }
    return problems;
})());

check('the query wins over the path, and code wins over c', (() => {
    const problems = [];
    // Ambiguous links only arrive hand-edited, but the app parses the same URL
    // independently (InviteLink.swift) and the two must not resolve a crafted
    // link to two different groups — the invitee would see one code and join
    // another. See tests/invite-contract.test.js for the cross-language check.
    const both = renderJoin({ search: '?code=BBBBB2', pathname: '/join/AAAAA2' });
    if (both.code !== 'BBBBB2') problems.push(`query+path resolved to '${both.code}', expected BBBBB2`);

    const ordered = renderJoin({ search: '?c=AAAAA2&code=BBBBB2' });
    if (ordered.code !== 'BBBBB2') {
        problems.push(`?c= before ?code= resolved to '${ordered.code}', expected BBBBB2 (code wins)`);
    }

    // An empty `code` is not an answer — fall through rather than give up.
    const empty = renderJoin({ search: '?code=&c=CLWNS7' });
    if (empty.code !== 'CLWNS7') {
        problems.push(`an empty ?code= with a valid ?c= resolved to '${empty.code}', expected CLWNS7`);
    }
    return problems;
})());

check('both inline scripts read the link the same way', (() => {
    // The banner block decides the campaign; the render block decides what the
    // visitor sees. They parse independently, so a change to one alone would
    // report an invite landing as a direct visit (or the reverse) — an
    // attribution number that quietly stops matching the page.
    const problems = [];
    const shapes = [
        ['?code=CLWNS7', '/join/'],
        ['?c=CLWNS7', '/join/'],
        ['', '/join/CLWNS7'],
        ['', '/join/CLWNS7/'],
        ['?code=clwns7', '/join/'],
        ['?code=CLWNS0', '/join/'],
        ['?code=CLWNS', '/join/'],
        ['', '/join/'],
        ['?code=&c=CLWNS7', '/join/'],
        ['?c=AAAAA2&code=BBBBB2', '/join/']
    ];
    for (const [search, pathname] of shapes) {
        const page = renderJoin({ search, pathname });
        const bannerSawCode = page.campaign === 'web_join_invite';
        if (bannerSawCode !== page.codeShown) {
            problems.push(
                `${pathname}${search}: banner campaign says code=${bannerSawCode}, ` +
                `page shows code=${page.codeShown}`
            );
        }
    }
    return problems;
})());

/* ---------- 2. the campaign split ---------- */

check('an invite landing and a direct visit report as different campaigns', (() => {
    const problems = [];
    const invite = renderJoin({ search: '?code=CLWNS7' });
    const direct = renderJoin({ search: '' });
    if (invite.campaign !== 'web_join_invite') {
        problems.push(`an invite landing reported '${invite.campaign}'`);
    }
    if (direct.campaign !== 'web_join_direct') {
        problems.push(`a direct visit reported '${direct.campaign}'`);
    }
    // A code that fails validation is somebody who was invited — the link
    // brought them here — but not somebody the page can help without asking.
    // It reports as direct, and that has to stay deliberate rather than drift.
    const junk = renderJoin({ search: '?code=CLWNS0' });
    if (junk.campaign !== 'web_join_direct') {
        problems.push(`a landing with an unusable code reported '${junk.campaign}'`);
    }
    return problems;
})());

// On every other page `?c=` is a press outlet token that gets folded into the
// campaign name. On /join it is the group code. Folding it here would mint an
// ASC campaign per group and publish private invite codes to a dashboard.
check('a group code never becomes part of a campaign name', (() => {
    const problems = [];
    const page = renderJoin({ search: '?c=CLWNS7', launched: true, providerToken: '123456789' });
    if (page.campaign !== 'web_join_invite') {
        problems.push(`campaign was '${page.campaign}'`);
    }
    const ct = decodeURIComponent((page.ctaHref.match(/[?&]ct=([^&]*)/) || [])[1] || '');
    if (ct !== 'web_join_invite') problems.push(`the download link carried ct='${ct}'`);
    if (page.banner && /CLWNS7/.test(page.banner.content.replace(/app-argument=[^,]*/, ''))) {
        problems.push(`the Smart App Banner leaked the code into its campaign: ${page.banner.content}`);
    }
    return problems;
})());

check('the banner and the download button report the same campaign', (() => {
    const problems = [];
    for (const search of ['?code=CLWNS7', '']) {
        const page = renderJoin({ search, launched: true, providerToken: '123456789' });
        const linkCt = decodeURIComponent((page.ctaHref.match(/[?&]ct=([^&]*)/) || [])[1] || '');
        const bannerCt = ((page.banner.content.match(/affiliate-data=([^,]*)/) || [])[1] || '')
            .split('&').filter((p) => p.startsWith('ct=')).map((p) => p.slice(3))[0] || '';
        if (linkCt !== bannerCt) {
            problems.push(`'${search || 'no query'}': link says ct=${linkCt}, banner says ct=${bannerCt}`);
        }
    }
    return problems;
})());

/* ---------- 3. before launch, the page still has to work ---------- */

// Everything above the download button is the invitee's whole reason to be
// here. Pre-launch the store link does not exist yet, and the page has to say
// so rather than break.
check('before launch the page renders and the CTA stays inert', (() => {
    const problems = [];
    const page = renderJoin({ launched: false, search: '?code=CLWNS7&lang=de' });
    if (page.code !== 'CLWNS7') problems.push('the code did not render');
    if (page.ctaHref !== '#') problems.push(`the CTA href became '${page.ctaHref}' before launch`);
    if (page.banner) problems.push('a Smart App Banner was written before launch');
    if (page.text('h1') !== I18N.de.h1) problems.push('the localized copy did not render');
    return problems;
})());

/* ---------- 4. the Smart App Banner ---------- */

check('the banner carries the App Clip card and this exact invite URL', (() => {
    const problems = [];
    const page = renderJoin({
        search: '?code=CLWNS7&ref=abc12345&sid=deadbeef&lang=ja',
        launched: true,
        providerToken: '123456789'
    });
    if (!page.banner) return ['no Smart App Banner was written after launch'];

    const fields = new Map(bannerFields(page.banner.content));
    if (fields.get('app-clip-display') !== 'card') {
        problems.push(`app-clip-display was '${fields.get('app-clip-display')}'`);
    }
    if (!/^com\.davidnguyen\.Cardio-Clowns\.Clip$/.test(fields.get('app-clip-bundle-id') || '')) {
        problems.push(`app-clip-bundle-id was '${fields.get('app-clip-bundle-id')}'`);
    }
    // The whole point of app-argument: the app opens on the invite URL and the
    // invitee never retypes the code.
    const argument = fields.get('app-argument') || '';
    if (!argument.includes('code=CLWNS7')) {
        problems.push(`app-argument lost the group code: '${argument}'`);
    }
    if (!argument.includes('sid=deadbeef')) {
        problems.push(`app-argument lost the share id, so the join cannot be attributed: '${argument}'`);
    }
    return problems;
})());

/*
 * The banner's `content` is a comma-separated field list and app-argument is
 * built from location.href — the entire URL, including whatever query the
 * person who sent the invite chose to put in it. A comma is legal in a query
 * string and browsers keep it literal, so this was not a mangled app-argument:
 * it was a second field, appended to the banner by whoever wrote the link.
 */
check('a crafted invite URL cannot inject Smart App Banner fields', (() => {
    const problems = [];
    const attacks = [
        '?code=CLWNS7&x=,app-id=999999999',
        '?code=CLWNS7&x=,app-clip-bundle-id=com.evil.Clip',
        '?code=CLWNS7&x=,app-argument=https://evil.example',
        '?code=CLWNS7&x=%20,%20affiliate-data=pt=666'
    ];
    const allowed = ['app-id', 'app-clip-bundle-id', 'app-clip-display', 'app-argument', 'affiliate-data'];
    for (const search of attacks) {
        const page = renderJoin({ search, launched: true, providerToken: '123456789' });
        if (!page.banner) { problems.push(`${search}: no banner written`); continue; }
        const names = bannerFields(page.banner.content).map(([name]) => name);
        for (const name of names) {
            if (!allowed.includes(name)) problems.push(`${search} injected field '${name}'`);
        }
        for (const name of allowed) {
            if (names.filter((n) => n === name).length > 1) {
                problems.push(`${search} injected a second '${name}' field: ${page.banner.content}`);
            }
        }
    }
    return problems;
})());

check('a legitimate invite URL survives that sanitising intact', (() => {
    // Encoding commas rather than dropping the argument is the point: %2C reads
    // back as a comma through URLComponents in the app, so the deep link still
    // carries the invitee to their group.
    const problems = [];
    const page = renderJoin({
        search: '?code=CLWNS7&ref=abc12345&sid=deadbeef&lang=pt-BR',
        launched: true,
        providerToken: '123456789'
    });
    const argument = (page.banner.content.match(/app-argument=([^,]*)/) || [])[1] || '';
    const expected = 'https://cardioclowns.com/join/?code=CLWNS7&ref=abc12345&sid=deadbeef&lang=pt-BR';
    if (argument !== expected) problems.push(`app-argument was '${argument}', expected '${expected}'`);
    return problems;
})());

/* ---------- 5. the sender's language ---------- */

check('every language ships every string the page renders', (() => {
    const problems = [];
    for (const lang of LANGS) {
        const keys = Object.keys(I18N[lang]).sort();
        const missing = COPY_KEYS.filter((k) => !keys.includes(k));
        const extra = keys.filter((k) => !COPY_KEYS.includes(k));
        if (missing.length) problems.push(`${lang} is missing: ${missing.join(', ')}`);
        if (extra.length) problems.push(`${lang} has keys no other language has: ${extra.join(', ')}`);
        for (const key of keys) {
            if (typeof I18N[lang][key] !== 'string' || I18N[lang][key].trim() === '') {
                problems.push(`${lang}.${key} is empty`);
            }
        }
    }
    return problems;
})());

// The one interpolation on the page. A translation that drops the placeholder
// loses the code out of the browser tab, in that language only.
check('every language keeps the {code} placeholder in its title', (() => {
    const problems = [];
    for (const lang of LANGS) {
        if (!I18N[lang].titleWithCode.includes('{code}')) {
            problems.push(`${lang}.titleWithCode has no {code}: ${I18N[lang].titleWithCode}`);
        }
        if (I18N[lang].title.includes('{code}')) {
            problems.push(`${lang}.title has a {code} that is never substituted`);
        }
    }
    return problems;
})());

// step1-3 are assigned through innerHTML, so their markup is live. Unbalanced
// tags reflow the rest of the list; anything scriptable would be worse.
check('the markup in translated steps is balanced and inert', (() => {
    const problems = [];
    for (const lang of LANGS) {
        for (const key of ['step1', 'step2', 'step3']) {
            const value = I18N[lang][key];
            const open = (value.match(/<strong>/g) || []).length;
            const close = (value.match(/<\/strong>/g) || []).length;
            if (open !== close) problems.push(`${lang}.${key} has ${open} <strong> and ${close} </strong>`);
            const tags = (value.match(/<\/?([a-zA-Z][\w-]*)/g) || []).map((t) => t.replace(/<\/?/, '').toLowerCase());
            for (const tag of tags) {
                if (tag !== 'strong') problems.push(`${lang}.${key} contains a <${tag}> tag`);
            }
            if (/on\w+\s*=/i.test(value)) problems.push(`${lang}.${key} contains an inline event handler`);
        }
    }
    return problems;
})());

check('the sender\'s language selects the copy, and unknown ones fall back', (() => {
    const problems = [];
    const cases = [
        ['de', 'de', 'an exact match'],
        ['DE', 'de', 'a differently-cased code'],
        ['de-AT', 'de', 'a regional variant of a language we have'],
        ['pt-BR', 'pt-BR', 'a code that is itself regional'],
        ['pt', 'pt-BR', 'the base of a regional-only language'],
        ['zh-Hans', 'zh-Hans', 'a script-qualified code'],
        ['zz', 'en', 'a language we do not have'],
        ['', 'en', 'an empty lang'],
        ['<img src=x onerror=alert(1)>', 'en', 'a crafted lang']
    ];
    for (const [input, expected, why] of cases) {
        const resolved = resolveLang(input);
        if (resolved !== expected) problems.push(`${why} ('${input}') resolved to '${resolved}', expected '${expected}'`);
    }
    // Resolution has to reach the document too — a page that renders German
    // copy while telling assistive tech and crawlers it is English is half done.
    const page = renderJoin({ search: '?code=CLWNS7&lang=de-AT' });
    if (page.lang !== 'de') problems.push(`<html lang> was '${page.lang}' for lang=de-AT`);
    if (page.text('h1') !== I18N.de.h1) problems.push('the German h1 did not render');
    const junk = renderJoin({ search: '?lang=<script>alert(1)</script>' });
    if (junk.lang !== 'en') problems.push(`a crafted lang reached <html lang>: '${junk.lang}'`);
    return problems;
})());

check('right-to-left languages flip the document, and only they do', (() => {
    const problems = [];
    for (const lang of LANGS) {
        const page = renderJoin({ search: `?code=CLWNS7&lang=${lang}` });
        const wantRTL = !!RTL[lang];
        const isRTL = page.dir === 'rtl';
        if (wantRTL !== isRTL) {
            problems.push(`${lang}: dir='${page.dir}', expected ${wantRTL ? 'rtl' : 'not rtl'}`);
        }
    }
    // Every language the page calls RTL has to be one it can actually render.
    for (const lang of Object.keys(RTL)) {
        if (!I18N[lang]) problems.push(`RTL lists '${lang}', which has no copy`);
    }
    return problems;
})());

check('every language renders a complete page with a code', (() => {
    const problems = [];
    for (const lang of LANGS) {
        const page = renderJoin({ search: `?code=CLWNS7&lang=${lang}` });
        const t = I18N[lang];
        const expectations = {
            h1: t.h1, sub: t.sub, 'code-label': t.codeLabel, 'cta-text': t.cta, home: t.home,
            'no-code': t.noCode, copy: t.copy
        };
        for (const [id, expected] of Object.entries(expectations)) {
            if (page.text(id) !== expected) {
                problems.push(`${lang}: #${id} rendered '${page.text(id)}', expected '${expected}'`);
            }
        }
        for (const step of ['step1', 'step2', 'step3']) {
            if (page.els.get(step).innerHTML !== t[step]) problems.push(`${lang}: #${step} did not render`);
        }
        const expectedTitle = t.titleWithCode.replace('{code}', 'CLWNS7');
        if (page.title !== expectedTitle) {
            problems.push(`${lang}: title was '${page.title}', expected '${expectedTitle}'`);
        }
    }
    return problems;
})());

check('a visitor with no code gets the untitled page and the instructions', (() => {
    const problems = [];
    for (const lang of ['en', 'ja', 'ar']) {
        const page = renderJoin({ search: `?lang=${lang}` });
        if (page.title !== I18N[lang].title) {
            problems.push(`${lang}: title was '${page.title}', expected '${I18N[lang].title}'`);
        }
        if (page.text('no-code') !== I18N[lang].noCode) problems.push(`${lang}: no-code copy missing`);
        if (page.codeShown) problems.push(`${lang}: showed a code block with no code`);
    }
    return problems;
})());

/* ---------- 6. the copy button ---------- */

check('copying hands over the normalised code, not the raw input', (() => {
    const problems = [];
    // Someone who typed the link by hand in lowercase must still copy something
    // the app's uppercase-only entry field accepts.
    const page = renderJoin({ search: '?code=clwns7' });
    page.clickCopy();
    if (page.copied[0] !== 'CLWNS7') problems.push(`copied '${page.copied[0]}', expected CLWNS7`);
    return problems;
})());

check('the copy button confirms, then goes back to its label', (() => {
    const problems = [];
    const page = renderJoin({ search: '?code=CLWNS7&lang=fr' });
    if (page.text('copy') !== I18N.fr.copy) problems.push('the button did not start with the localized label');
    page.clickCopy();
    if (page.text('copy') !== I18N.fr.copied) {
        problems.push(`after copying the button read '${page.text('copy')}', expected '${I18N.fr.copied}'`);
    }
    page.runTimers();
    if (page.text('copy') !== I18N.fr.copy) {
        problems.push(`the button never reverted — it still reads '${page.text('copy')}'`);
    }
    return problems;
})());

check('copying still works without the clipboard API', (() => {
    // The invite page is opened in whatever in-app browser the message arrived
    // in. navigator.clipboard needs a secure context and is not always there.
    const problems = [];
    const page = renderJoin({ search: '?code=CLWNS7', clipboard: false });
    page.clickCopy();
    if (page.copied[0] !== 'CLWNS7') {
        problems.push(`the execCommand fallback copied '${page.copied[0]}', expected CLWNS7`);
    }
    if (page.text('copy') !== I18N.en.copied) problems.push('the fallback path never confirmed');
    return problems;
})());

/* ---------- 7. the page's own structure ---------- */

check('the page ships every element its scripts write to', (() => {
    const problems = [];
    const written = new Set();
    for (const src of INLINE_SCRIPTS) {
        const re = /getElementById\('([\w-]+)'\)/g;
        let m;
        while ((m = re.exec(src)) !== null) written.add(m[1]);
    }
    for (const id of written) {
        if (!SHIPPED_ELEMENTS.has(id)) problems.push(`the scripts write to #${id}, which the markup does not ship`);
    }
    return problems;
})());

check('the code block and the fallback start hidden and never both show', (() => {
    const problems = [];
    if (!SHIPPED_ELEMENTS.get('code-block').hidden) problems.push('#code-block does not ship hidden');
    if (!SHIPPED_ELEMENTS.get('no-code').hidden) problems.push('#no-code does not ship hidden');
    for (const search of ['?code=CLWNS7', '?code=CLWNS0', '']) {
        const page = renderJoin({ search });
        if (page.codeShown && page.noCodeShown) problems.push(`'${search || 'no query'}': both blocks visible`);
        if (!page.codeShown && !page.noCodeShown) problems.push(`'${search || 'no query'}': neither block visible`);
    }
    return problems;
})());

check('the invite page stays out of search results', (() => {
    // Group codes are private. An indexed /join/?code= page would publish them.
    const problems = [];
    if (!/<meta name="robots" content="noindex">/.test(JOIN_HTML)) {
        problems.push('join/index.html has no noindex robots meta');
    }
    return problems;
})());

/* ---------- run ---------- */

console.log();
if (failures) {
    console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
    process.exit(1);
}
console.log(`\x1b[32mall ${checks} checks passed\x1b[0m`);

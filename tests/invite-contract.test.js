/*
 * The invite contract between this site and the iOS app.
 * Run: node tests/invite-contract.test.js
 *
 * WHY THIS EXISTS
 *
 * An invite link is one string that four independent pieces of code have to
 * agree about, written in two languages and living in two repositories:
 *
 *   InviteCopy.joinURL      (app)   builds it
 *   InviteLink.code(from:)  (app)   parses it, for both the app and the App Clip
 *   join/index.html         (site)  parses it again, twice, in JavaScript
 *   apple-app-site-association      decides whether iOS hands it to the app at all
 *
 * Nothing connects them. They agree today because someone kept them in step by
 * hand, and every way they can fall out of step is invisible from both sides:
 *
 *   - a code shape the site accepts and the app rejects shows the invitee a
 *     code that does not work, with no error anywhere
 *   - the app shipping a language the site has no copy for renders an English
 *     page to someone invited in Japanese — the app is right, the site is
 *     right, and the invite is worse
 *   - a bundle id typo in the AASA file, or a path it stops covering, sends
 *     every invite to the web page instead of the app, forever, silently
 *
 * These are the checks that could not live in either repo alone. The app-side
 * half of each contract is read out of the app's own source rather than copied
 * here, so this file cannot drift into agreeing with a stale copy of itself.
 *
 * The app checkout is found at ../cardioclowns2, or wherever CC_APP_REPO
 * points. Without it the cross-repo checks are reported and skipped, the same
 * way launch-readiness.test.js reports what is still open — a machine that only
 * has the website should not fail a suite it cannot run.
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
let skipped = 0;

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

function skip(name, why) {
    skipped++;
    console.log(`  --    ${name}`);
    console.log(`          ${why}`);
}

// How many checks live behind the app checkout, so a skipped run says how much
// it did not do rather than quietly reporting two passes as a green suite.
const CROSS_REPO_CHECKS = 11;

/* ---------- the website side ---------- */

const JOIN_HTML = fs.readFileSync(path.join(ROOT, 'join/index.html'), 'utf8');
const AASA = JSON.parse(fs.readFileSync(path.join(ROOT, '.well-known/apple-app-site-association'), 'utf8'));

/** A `{ ... }` object literal out of a source file, brace-balanced rather than
 *  regexed so a nested object or a brace in a string can't truncate it. */
function objectLiteral(src, declaration, file) {
    const at = src.indexOf(declaration);
    if (at === -1) {
        console.error(`Could not find \`${declaration}\` in ${file} — did it change shape?`);
        process.exit(1);
    }
    const start = src.indexOf('{', at);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
            return vm.runInNewContext('(' + src.slice(start, i + 1) + ')');
        }
    }
    console.error(`Unbalanced braces after \`${declaration}\` in ${file}.`);
    process.exit(1);
}

const I18N = objectLiteral(JOIN_HTML, 'var I18N = {', 'join/index.html');
const RTL = objectLiteral(JOIN_HTML, 'var RTL = {', 'join/index.html');

// resolveLang decides which copy a `?lang=` gets. Lifted whole rather than
// re-implemented — a re-implementation would test itself.
const resolveLang = (() => {
    const at = JOIN_HTML.indexOf('function resolveLang(');
    if (at === -1) {
        console.error('Could not find `function resolveLang(` in join/index.html.');
        process.exit(1);
    }
    const start = JOIN_HTML.indexOf('{', at);
    let depth = 0;
    for (let i = start; i < JOIN_HTML.length; i++) {
        if (JOIN_HTML[i] === '{') depth++;
        else if (JOIN_HTML[i] === '}' && --depth === 0) {
            const source = JOIN_HTML.slice(at, i + 1);
            const sandbox = { I18N };
            vm.runInNewContext(source + '\nthis.resolveLang = resolveLang;', sandbox);
            return sandbox.resolveLang;
        }
    }
    console.error('Unbalanced braces in resolveLang().');
    process.exit(1);
})();

/** Every character a JS character class like `[A-HJ-NP-Z2-9]` accepts. */
function expandCharClass(source) {
    const chars = new Set();
    for (let i = 0; i < source.length; i++) {
        if (source[i + 1] === '-' && i + 2 < source.length) {
            for (let c = source.charCodeAt(i); c <= source.charCodeAt(i + 2); c++) {
                chars.add(String.fromCharCode(c));
            }
            i += 2;
        } else {
            chars.add(source[i]);
        }
    }
    return chars;
}

// The page validates the code with this regex, in both of its inline scripts.
const pageCodePatterns = [...JOIN_HTML.matchAll(/\/\^\[([^\]]+)\]\{(\d+)\}\$\//g)]
    .map((m) => ({ chars: expandCharClass(m[1]), length: Number(m[2]), source: m[0] }));

if (pageCodePatterns.length === 0) {
    console.error('Could not find a code-validation regex in join/index.html.');
    process.exit(1);
}

/**
 * The `app-argument` the join page's Smart App Banner would hand the app for a
 * given invite URL, post-launch — produced by running the page's own banner
 * block against the shipped appstore.js, so this cannot drift into asserting a
 * string the page stopped writing.
 *
 * Only what that block touches is modelled: it runs inline in the head, where
 * there is no body and no element to reach for. tests/smart-app-banner.test.js
 * is what holds it to that.
 */
function bannerArgument(search) {
    const block = (() => {
        const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
        let m;
        while ((m = re.exec(JOIN_HTML)) !== null) {
            if (/CCStore\.smartBanner\(/.test(m[1])) return m[1];
        }
        console.error('No inline script in join/index.html calls CCStore.smartBanner().');
        process.exit(1);
    })();

    const appstore = fs.readFileSync(path.join(ROOT, 'appstore.js'), 'utf8');
    const launched = appstore.replace(/var LAUNCHED = false;/, 'var LAUNCHED = true;');
    if (launched === appstore && !/var LAUNCHED = true;/.test(appstore)) {
        console.error('Could not patch LAUNCHED in appstore.js — the declaration changed shape.');
        process.exit(1);
    }

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
    const context = vm.createContext({});
    vm.runInContext('var window = this;', context);
    Object.assign(context, {
        document,
        location: { search, pathname: '/join/', href: 'https://cardioclowns.com/join/' + search },
        URLSearchParams,
        console: { warn() {}, log() {} }
    });
    vm.runInContext(launched, context, { filename: 'appstore.js' });
    vm.runInContext(block, context, { filename: 'join:banner' });

    const meta = appended.find((n) => n.name === 'apple-itunes-app');
    if (!meta) return '';
    // Split on every comma, the way iOS reads the field list.
    const field = meta.content.split(',')
        .map((f) => f.trim())
        .find((f) => f.startsWith('app-argument='));
    return field ? field.slice('app-argument='.length) : '';
}

/* ---------- the app side, if it is here ---------- */

const APP_REPO = process.env.CC_APP_REPO || path.join(ROOT, '..', 'cardioclowns2');
const APP_SRC = path.join(APP_REPO, 'Cardio Clowns');

function appFile(relative) {
    return fs.readFileSync(path.join(APP_SRC, relative), 'utf8');
}

const appAvailable = (() => {
    try {
        appFile('Shared/InviteLink.swift');
        return true;
    } catch (e) {
        return false;
    }
})();

let app = null;
if (appAvailable) {
    const inviteLink = appFile('Shared/InviteLink.swift');
    const contentView = appFile('Cardio Clowns/ContentView.swift');
    const localization = appFile('Shared/Localization.swift');
    const cloudKit = appFile('Shared/CloudKitManager.swift');
    const pbxproj = appFile('Cardio Clowns.xcodeproj/project.pbxproj');
    const appEntitlements = appFile('Cardio Clowns/Cardio Clowns.entitlements');
    const clipEntitlements = appFile('Cardio Clowns Clip/Cardio Clowns Clip.entitlements');

    const read = (src, pattern, label) => {
        const m = src.match(pattern);
        if (!m) {
            console.error(`Could not read ${label} out of the app source — it changed shape.`);
            process.exit(1);
        }
        return m[1];
    };

    app = {
        // The alphabet the app validates an invite code against.
        alphabet: new Set(read(
            inviteLink,
            /let allowed = CharacterSet\(charactersIn: "([A-Z0-9]+)"\)/,
            'the invite code alphabet'
        ).split('')),
        codeLength: Number(read(inviteLink, /code\.count == (\d+)/, 'the invite code length')),
        // The alphabet a *generated* code is drawn from, which is the one that
        // decides what codes exist in the world.
        generatorAlphabet: new Set(read(
            cloudKit,
            /codeChars = Array\("([A-Z0-9]+)"\)/,
            'the code generator alphabet'
        ).split('')),
        generatorLength: Number(read(cloudKit, /codeLength = (\d+)/, 'the generated code length')),
        joinURLTemplate: read(contentView, /var link = "(https:\/\/[^"]+)"/, 'the join URL template'),
        // Every query parameter joinURL appends.
        joinURLParams: [
            ...contentView.matchAll(/link \+= "&(\w+)=/g)
        ].map((m) => m[1]),
        languages: [...localization.matchAll(/^\s+\("([\w-]+)", "/gm)].map((m) => m[1]),
        appBundleID: 'com.davidnguyen.Cardio-Clowns',
        clipBundleID: read(
            pbxproj,
            /PRODUCT_BUNDLE_IDENTIFIER = "(com\.davidnguyen\.Cardio-Clowns\.Clip)"/,
            'the App Clip bundle id'
        ),
        teamID: read(pbxproj, /DEVELOPMENT_TEAM = (\w+);/, 'the development team id'),
        appDomains: [...appEntitlements.matchAll(/<string>applinks:([^<?]+)/g)].map((m) => m[1]),
        clipDomains: [...clipEntitlements.matchAll(/<string>appclips:([^<?]+)/g)].map((m) => m[1])
    };
}

console.log(
    `join page: ${Object.keys(I18N).length} languages · ` +
    (appAvailable ? `app: ${app.languages.length} languages, code ${app.codeLength} of ${app.alphabet.size}` : 'app checkout not found') +
    '\n'
);

/* ---------- 1. the same code means the same thing on both sides ---------- */

if (!appAvailable) {
    skip(
        `${CROSS_REPO_CHECKS} cross-repo checks (codes, languages, bundle ids, entitlements)`,
        `no app checkout at ${APP_REPO} — set CC_APP_REPO to run them`
    );
} else {
    check('the site and the app accept exactly the same invite codes', (() => {
        const problems = [];
        for (const { chars, length, source } of pageCodePatterns) {
            const siteOnly = [...chars].filter((c) => !app.alphabet.has(c)).sort();
            const appOnly = [...app.alphabet].filter((c) => !chars.has(c)).sort();
            if (siteOnly.length) {
                problems.push(
                    `${source} accepts ${siteOnly.join('')}, which InviteLink.swift rejects — ` +
                    'the page would show a code the app cannot join with'
                );
            }
            if (appOnly.length) {
                problems.push(
                    `InviteLink.swift accepts ${appOnly.join('')}, which ${source} rejects — ` +
                    'the page would tell a valid invitee to ask their friend for the code'
                );
            }
            if (length !== app.codeLength) {
                problems.push(`${source} wants ${length} characters, InviteLink.swift wants ${app.codeLength}`);
            }
        }
        return problems;
    })());

    check('every code the app can generate is a code the site can display', (() => {
        // The parser alphabets agreeing is not enough on its own — what matters
        // is that a code CloudKitManager actually mints passes both of them.
        const problems = [];
        const ungenerated = [...app.generatorAlphabet].filter((c) => !app.alphabet.has(c)).sort();
        if (ungenerated.length) {
            problems.push(`the generator can mint ${ungenerated.join('')}, which the app's own parser rejects`);
        }
        for (const { chars, length } of pageCodePatterns) {
            const unshowable = [...app.generatorAlphabet].filter((c) => !chars.has(c)).sort();
            if (unshowable.length) {
                problems.push(`the generator can mint ${unshowable.join('')}, which the join page rejects`);
            }
            if (app.generatorLength !== length) {
                problems.push(`generated codes are ${app.generatorLength} characters, the page expects ${length}`);
            }
        }
        return problems;
    })());

    check('the link the app builds is a link this site is serving', (() => {
        const problems = [];
        const url = new URL(app.joinURLTemplate.replace('\\(groupCode)', 'CLWNS7'));
        if (url.protocol !== 'https:') problems.push(`joinURL is ${url.protocol}, not https`);
        if (url.hostname !== 'cardioclowns.com') {
            problems.push(`joinURL points at ${url.hostname}, which this repo does not serve`);
        }
        if (!fs.existsSync(path.join(ROOT, url.pathname, 'index.html'))) {
            problems.push(`joinURL points at ${url.pathname}, which has no index.html in this repo`);
        }
        // The site is also what CNAME says it is — a joinURL pointing at a host
        // this repo does not publish is a dead invite.
        const cname = fs.readFileSync(path.join(ROOT, 'CNAME'), 'utf8').trim();
        if (cname !== url.hostname) problems.push(`CNAME serves ${cname}, joinURL points at ${url.hostname}`);
        return problems;
    })());

    check('every parameter the app puts in an invite link is one the page reads', (() => {
        const problems = [];
        // `code` is in the template rather than appended, so it is checked
        // through the parser above; these are the extras that ride along.
        const understood = {
            ref: 'ignored by the page on purpose — it is for the app\'s funnel',
            sid: 'ignored by the page on purpose — it is for the app\'s funnel',
            lang: 'read by the page to pick the sender\'s language'
        };
        for (const param of app.joinURLParams) {
            if (!(param in understood)) {
                problems.push(
                    `joinURL appends '&${param}=' and no one here knows what it is — ` +
                    'either the page should read it or this list should say why not'
                );
            }
        }
        if (!app.joinURLParams.includes('lang')) {
            problems.push('joinURL no longer sends `lang`, so every invite page renders in English');
        }
        // The page has to actually consume it, not just tolerate it.
        if (!/params\.get\('lang'\)/.test(JOIN_HTML)) {
            problems.push('the join page no longer reads ?lang=, so the sender\'s language is dropped');
        }
        return problems;
    })());

    /* ---------- 2. the sender's language survives the trip ---------- */

    check('every language the app can invite in has copy on the join page', (() => {
        const problems = [];
        for (const lang of app.languages) {
            const resolved = resolveLang(lang);
            if (lang !== 'en' && resolved === 'en') {
                problems.push(
                    `the app can send &lang=${lang}, and the join page falls back to English for it — ` +
                    'an invitee invited in that language lands on an English page'
                );
            }
        }
        return problems;
    })());

    check('the join page has no copy for a language the app cannot send', (() => {
        // Not a failure mode for users, but unreachable translations are work
        // that will silently rot, and a language dropped from the app should
        // take its page copy with it.
        const canSend = new Set(app.languages);
        return Object.keys(I18N)
            .filter((lang) => !canSend.has(lang))
            .map((lang) => `join/index.html has ${lang} copy, but the app never sends &lang=${lang}`);
    })());

    check('the two repos agree on which languages are right-to-left', (() => {
        const problems = [];
        // The app gets its direction from iOS; the page has to be told. A
        // language the app ships that reads right-to-left and is not in RTL
        // renders a mirrored-looking page to the invitee.
        const knownRTL = ['ar', 'he', 'ur', 'fa', 'yi'];
        for (const lang of app.languages) {
            if (knownRTL.includes(lang) && !RTL[lang]) {
                problems.push(`the app ships ${lang}, which is right-to-left, and the join page does not flip for it`);
            }
        }
        return problems;
    })());

    /* ---------- 3. iOS has to hand the link to the app in the first place ---------- */

    check('the AASA file names the app and the clip this project builds', (() => {
        const problems = [];
        const appIDs = ((AASA.applinks || {}).details || []).flatMap((d) => d.appIDs || []);
        const clipIDs = (AASA.appclips || {}).apps || [];
        const expectedApp = `${app.teamID}.${app.appBundleID}`;
        const expectedClip = `${app.teamID}.${app.clipBundleID}`;
        if (!appIDs.includes(expectedApp)) {
            problems.push(`AASA applinks lists ${JSON.stringify(appIDs)}, expected ${expectedApp}`);
        }
        if (!clipIDs.includes(expectedClip)) {
            problems.push(`AASA appclips lists ${JSON.stringify(clipIDs)}, expected ${expectedClip}`);
        }
        return problems;
    })());

    check('the app claims the domain this site is published on', (() => {
        const problems = [];
        const host = new URL(app.joinURLTemplate.replace('\\(groupCode)', 'X')).hostname;
        if (!app.appDomains.includes(host)) {
            problems.push(`the app's applinks entitlement lists ${JSON.stringify(app.appDomains)}, not ${host}`);
        }
        if (!app.clipDomains.includes(host)) {
            problems.push(`the clip's appclips entitlement lists ${JSON.stringify(app.clipDomains)}, not ${host}`);
        }
        return problems;
    })());

    check('the join page offers the App Clip this project builds', (() => {
        const m = JOIN_HTML.match(/clipBundleID: '([^']+)'/);
        if (!m) return ['join/index.html no longer passes a clipBundleID, so the App Clip card never appears'];
        return m[1] === app.clipBundleID
            ? []
            : [`the page offers ${m[1]}, the project builds ${app.clipBundleID}`];
    })());

    /*
     * The Smart App Banner hand-off, which is the one place the two repos
     * exchange a string at runtime rather than merely agreeing about a format.
     *
     * An invitee without the app installs from the banner on /join and taps
     * Open; iOS hands the app the banner's `app-argument` verbatim. The website
     * half — that the banner writes that string with the code intact and its
     * commas encoded — is tests/smart-app-banner.test.js here. The app half —
     * that InviteLink parses it back into a group code — is InviteLinkTests
     * .swift over there. Both pass today against literals someone copied across
     * by hand, which is exactly how they will drift.
     *
     * So the string the banner produces has to be a string the app's own tests
     * actually exercise. Change how the page builds app-argument and this fails
     * until the app-side case is updated to match — which is the only moment
     * anyone would think to look.
     */
    check('the app tests the exact link the Smart App Banner hands it', (() => {
        const problems = [];
        let inviteLinkTests;
        try {
            inviteLinkTests = appFile('Cardio Clowns Tests/InviteLinkTests.swift');
        } catch (e) {
            return ['the app checkout has no InviteLinkTests.swift'];
        }

        // Built by running the shipped page, not written out here — a
        // hand-written expectation would be a third copy to keep in step.
        const argument = bannerArgument('?code=CLWNS7&ref=abc12345&sid=deadbeef&lang=pt-BR');
        if (!argument) return ['the join page banner carries no app-argument, so nothing is handed to the app'];

        // Pinning a string that no longer carries a code would still "match" —
        // every invite URL shares an origin and path, and the app's own
        // rejection cases use bare ones. tests/smart-app-banner.test.js is what
        // diagnoses that properly; this is here so a coincidental match cannot
        // report the contract as held.
        if (!/[?&]c(ode)?=CLWNS7(&|$)/.test(argument)) {
            problems.push(
                `the banner's app-argument is '${argument}', which carries no group code — ` +
                'pinning it against the app proves nothing'
            );
        }

        // Matched as a whole quoted literal, not as a substring: every invite
        // URL starts with the same origin and path, so a plain `includes` is
        // satisfied by any longer case that happens to share the prefix — and
        // a banner that had stopped carrying the code would still pass.
        if (!inviteLinkTests.includes(`"${argument}"`)) {
            problems.push(
                `the banner hands the app '${argument}', and no case in InviteLinkTests.swift ` +
                'uses that string — the hand-off is untested on the app side'
            );
        }

        // The %2C encoding is a claim about Swift, made in JavaScript:
        // appstore.js encodes commas instead of dropping the argument
        // *because* URLComponents decodes them back. If the app stops covering
        // that, the website is sanitising on the strength of an assumption.
        if (!/%2C/.test(inviteLinkTests)) {
            problems.push(
                'no case in InviteLinkTests.swift parses a %2C-encoded invite URL — ' +
                'appstore.js encodes commas on the assumption that the app decodes them'
            );
        }
        return problems;
    })());
}

/* ---------- 4. the AASA file, which stands alone ---------- */

check('the AASA file covers every shape an invite link takes', (() => {
    const problems = [];
    const patterns = ((AASA.applinks || {}).details || [])
        .flatMap((d) => (d.components || []).map((c) => c['/']))
        .concat(((AASA.applinks || {}).details || []).flatMap((d) => d.paths || []));

    // The link shapes the site itself documents as valid. If iOS does not match
    // one of these, that invite opens Safari instead of the app — no error, no
    // fallback, just a worse funnel that nobody is told about.
    const mustMatch = ['/join', '/join/', '/join/CLWNS7', '/join/CLWNS7/'];
    const matches = (pattern, pathname) => {
        const re = new RegExp('^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\?/g, '.')
            .replace(/\*/g, '.*') + '$');
        return re.test(pathname);
    };
    for (const pathname of mustMatch) {
        if (!patterns.some((p) => typeof p === 'string' && matches(p, pathname))) {
            problems.push(`no AASA pattern matches ${pathname} — that invite would open Safari, not the app`);
        }
    }
    return problems;
})());

check('the AASA file is served the way iOS requires', (() => {
    const problems = [];
    // Unsigned JSON at a fixed path, no extension. GitHub Pages serves it as
    // application/json from .well-known; a .json suffix or a Jekyll rebuild
    // dropping the dot-directory both break it silently.
    const file = path.join(ROOT, '.well-known/apple-app-site-association');
    if (!fs.existsSync(file)) problems.push('.well-known/apple-app-site-association is missing');
    if (fs.existsSync(file + '.json')) problems.push('a .json copy exists — iOS fetches the extensionless path');
    if (!fs.existsSync(path.join(ROOT, '.nojekyll'))) {
        problems.push('no .nojekyll — GitHub Pages will not publish the .well-known directory');
    }
    return problems;
})());

/* ---------- run ---------- */

console.log();
if (failures) {
    console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
    process.exit(1);
}
const note = skipped ? ` · ${CROSS_REPO_CHECKS} skipped (no app checkout)` : '';
console.log(`\x1b[32mall ${checks} checks passed${note}\x1b[0m`);

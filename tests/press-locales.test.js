/*
 * Locale wiring tests. Run: node tests/press-locales.test.js
 *
 * WHY THIS EXISTS
 *
 * The press page resolves ?m=<code> through a MARKETS map, and an unknown code
 * is not an error — `if (!MARKETS[market]) market = null;` falls back to
 * English deliberately, so a visitor with a junk URL still sees a working page.
 *
 * That fallback also hides mistakes. Tamil had i18n copy at press/i18n/ta.json
 * and screenshots at media/shots/ta-IN/ for weeks, but no MARKETS entry pointed
 * at it — so cardioclowns.com/press?m=ta silently served English. Nothing threw,
 * nothing 404'd, and the only way to notice was to open the URL and read Tamil.
 *
 * Every check below is a way for a locale to be half-wired: present in one map
 * and missing from another. None of them surface at runtime.
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

/* ---------- load the three sources of truth ---------- */

// media.js and lang.js are IIFEs that hang their maps off `window`. They only
// touch document/navigator inside functions, so a bare object is enough.
function loadBrowserGlobal(file) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
    return sandbox.window;
}

const { CCMedia } = loadBrowserGlobal('media.js');
const { CCLang } = loadBrowserGlobal('lang.js');

// MARKETS is inline in press/index.html, so it has to come out of the source
// text. Brace-balanced scan rather than a regex, so a nested object or a `}` in
// a comment can't truncate it silently.
const pressHtml = fs.readFileSync(path.join(ROOT, 'press/index.html'), 'utf8');
const marketsStart = pressHtml.indexOf('var MARKETS = {');
if (marketsStart === -1) {
    console.error('Could not find `var MARKETS = {` in press/index.html — did the press page change shape?');
    process.exit(1);
}
const braceStart = pressHtml.indexOf('{', marketsStart);
let depth = 0;
let braceEnd = -1;
for (let i = braceStart; i < pressHtml.length; i++) {
    if (pressHtml[i] === '{') depth++;
    else if (pressHtml[i] === '}') {
        depth--;
        if (depth === 0) { braceEnd = i; break; }
    }
}
const marketsSource = pressHtml.slice(braceStart, braceEnd + 1);
const MARKETS = vm.runInNewContext('(' + marketsSource + ')');

const i18nLangs = fs.readdirSync(path.join(ROOT, 'press/i18n'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

const pickerLangs = CCLang.LANGS.map((entry) => entry[0]);

// English is the copy already written into press/index.html, not an override
// fetched over the network — lang.js short-circuits it: `if (code === 'en')
// { apply('en', EN); return; }`. So press/i18n/en.json is *supposed* to be
// absent, and every check that looks for a translation file has to say so.
const BASE_LANG = 'en';

console.log(`press/i18n: ${i18nLangs.length} languages · MARKETS: ${Object.keys(MARKETS).length} codes · picker: ${pickerLangs.length} languages\n`);

/* ---------- 1. the bug that motivated this file ---------- */

// A language with translated press copy that no ?m= code can reach is invisible
// work: the pitch links English and the localization argument evaporates.
check('every translated language is reachable by some ?m= code', (() => {
    const reachable = new Set(Object.values(MARKETS).map(([lang]) => lang));
    return i18nLangs
        .filter((lang) => !reachable.has(lang))
        .map((lang) => `press/i18n/${lang}.json exists but no MARKETS entry points at '${lang}' — ?m= for it serves English`);
})());

/* ---------- 2. the same gap in reverse ---------- */

check('every ?m= code has translated copy to show', (() => {
    const have = new Set(i18nLangs);
    return Object.entries(MARKETS)
        .filter(([, [lang]]) => lang !== BASE_LANG && !have.has(lang))
        .map(([code, [lang]]) => `?m=${code} resolves to language '${lang}' but press/i18n/${lang}.json does not exist`);
})());

/* ---------- 3. the picker must not offer a dead language ---------- */

check('every language in the picker has translated copy', (() => {
    const have = new Set(i18nLangs);
    return pickerLangs
        .filter((lang) => lang !== BASE_LANG && !have.has(lang))
        .map((lang) => `lang.js offers '${lang}' but press/i18n/${lang}.json does not exist`);
})());

/* ---------- 4. asset locales must resolve to real files ---------- */

// MARKETS[code][1] is an App Store locale folder, and the folder names come
// from App Store Connect rather than from the language code — nb -> no,
// ur -> ur-PK, the whole Indic *-IN set. Easy to typo, invisible when wrong:
// the <img> just 404s against a locale nobody tests.
check('every market asset locale has screenshots and a preview video', (() => {
    const problems = [];
    for (const [code, [, locale]] of Object.entries(MARKETS)) {
        if (!fs.existsSync(path.join(ROOT, 'media/shots', locale))) {
            problems.push(`?m=${code} -> media/shots/${locale}/ does not exist`);
        }
        for (const ext of ['mp4', 'jpg']) {
            if (!fs.existsSync(path.join(ROOT, 'media/preview', `${locale}.${ext}`))) {
                problems.push(`?m=${code} -> media/preview/${locale}.${ext} does not exist`);
            }
        }
    }
    return problems;
})());

/* ---------- 5. MARKETS and LANG_ASSETS must agree ---------- */

// Both files map a language onto an App Store locale, so they can disagree.
// They're allowed to, but only where a market is genuinely narrower than its
// language: en covers four storefronts with four different flags on the
// leaderboard, and es covers Spain and Mexico. Anywhere else, a mismatch is a
// typo that silently serves the wrong country's screenshots.
const NARROWER_THAN_LANGUAGE = { us: 'en-US', gb: 'en-GB', ca: 'en-CA', au: 'en-AU', mx: 'es-MX' };

check('market asset locales agree with media.js, except documented narrow markets', (() => {
    const problems = [];
    for (const [code, [lang, locale]] of Object.entries(MARKETS)) {
        if (code in NARROWER_THAN_LANGUAGE) {
            if (locale !== NARROWER_THAN_LANGUAGE[code]) {
                problems.push(`?m=${code} is a documented narrow market expecting '${NARROWER_THAN_LANGUAGE[code]}' but maps to '${locale}'`);
            }
            continue;
        }
        const expected = CCMedia.LANG_ASSETS[lang];
        if (expected === undefined) {
            problems.push(`?m=${code} -> language '${lang}' is missing from CCMedia.LANG_ASSETS, so its assets fall back to en-US`);
        } else if (expected !== locale) {
            problems.push(`?m=${code} maps to '${locale}' but media.js maps '${lang}' to '${expected}' — one of them is wrong`);
        }
    }
    return problems;
})());

/* ---------- 6. duplicate keys ---------- */

// A repeated key in an object literal is not a syntax error; the last one wins
// and the earlier entry vanishes. Only visible in the source text, so this has
// to run against the raw slice rather than the evaluated object.
check('no duplicate market codes', (() => {
    // Comments have to go first. A key is recognised by the `{` or `,` that
    // precedes it, and \s* cannot span comment text — so with the comments left
    // in, every key that opens a commented block (`pl`, `ta`, `cat`) was
    // invisible here. That is the worst possible blind spot: a commented block
    // is exactly where new entries get appended.
    //
    // Naive stripping is safe for this object specifically — every value is a
    // quoted locale code, and none contains `//` or `/*`.
    const withoutComments = marketsSource
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');

    const seen = new Set();
    const dupes = [];
    const keyPattern = /(?:^|[{,])\s*'?([A-Za-z][\w-]*)'?\s*:/g;
    let m;
    while ((m = keyPattern.exec(withoutComments)) !== null) {
        const key = m[1];
        if (seen.has(key)) dupes.push(`'${key}' appears more than once in MARKETS — the later entry silently wins`);
        seen.add(key);
    }

    // Cross-check against the evaluated object: if the text scan and the parsed
    // object disagree on how many keys exist, this check is lying about its
    // coverage and should say so rather than report a confident pass.
    const parsedCount = Object.keys(MARKETS).length;
    if (dupes.length === 0 && seen.size !== parsedCount) {
        dupes.push(`scanned ${seen.size} keys in the source text but the parsed object has ${parsedCount} — the key pattern is missing entries, so this check cannot be trusted`);
    }
    return dupes;
})());

/* ---------- summary ---------- */

console.log();
if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed`);
    process.exit(1);
}
console.log(`all ${checks} checks passed`);

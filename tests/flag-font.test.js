/*
 * Country-flag rendering tests. Run: node tests/flag-font.test.js
 *
 * WHY THIS EXISTS
 *
 * Windows has no country-flag emoji. Segoe UI Emoji omits them on purpose, so
 * a regional-indicator pair renders as its two underlying letters instead: the
 * hero leaderboard read "Mom VN" / "You US" for every Windows visitor while
 * looking perfect on macOS, iOS and Android. Nothing throws, nothing 404s, and
 * the developing machine is a Mac — the only way to catch it was for someone on
 * Windows to open the page and say so.
 *
 * index.html now ships Twemoji's flag glyphs to cover the gap, subset to just
 * the flags the site uses so it costs 4.8 KB instead of 78 KB. That subset is
 * the new tripwire: add 🇬🇧 to the leaderboard mock and it renders correctly on
 * the Mac you're editing on, and as "GB" on Windows, exactly like before.
 *
 * So: every flag in the site must be a flag the shipped font can draw, and
 * every page rendering one must actually load that font.
 *
 * To add a flag, regenerate the subset with the new codepoints appended:
 *
 *   pyftsubset TwemojiCountryFlags.woff2 --flavor=woff2 --layout-features='*' \
 *     --unicodes=U+1F1FA,U+1F1F8,U+1F1FB,U+1F1F3 \
 *     --output-file=fonts/TwemojiCountryFlags-subset.woff2
 *
 * (source font: country-flag-emoji-polyfill on npm, MIT; art is Twemoji, CC-BY 4.0)
 *
 * Dependency-free on purpose — this repo is static files on GitHub Pages and
 * has no package.json. Keep it that way. The woff2 reader below is a few dozen
 * lines because of that; Node's built-in brotli does the heavy lifting.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

const hex = (cp) => 'U+' + cp.toString(16).toUpperCase();

/* ---------- where flags are allowed to appear ---------- */

// A flag only renders if the page showing it loads the flag font. i18n strings
// are swapped into a host page by lang.js, so they inherit that page's fonts.
// Anything not listed here is a page that has never been checked — extend the
// table (and wire the @font-face into that page) rather than deleting the case.
const HOST_PAGE = [
    { match: (f) => f === 'index.html', page: 'index.html' },
    { match: (f) => f.startsWith('i18n/'), page: 'index.html' },
    { match: (f) => f === 'press/index.html', page: 'press/index.html' },
    { match: (f) => f.startsWith('press/i18n/'), page: 'press/index.html' },
];

/* ---------- find every flag the site renders ---------- */

// A flag emoji is two regional indicators; \u{1F1E6}-\u{1F1FF} is the block.
const FLAG_PAIR = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const TEXT_FILE = /\.(html|json|js|css|md)$/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (TEXT_FILE.test(entry.name)) out.push(full);
    }
    return out;
}

const usage = new Map(); // codepoint -> Set of relative file paths
const filesWithFlags = new Set();

for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.startsWith('tests/')) continue; // this file names flags to explain itself
    const text = fs.readFileSync(file, 'utf8');
    for (const pair of text.match(FLAG_PAIR) || []) {
        filesWithFlags.add(rel);
        for (const ch of [...pair]) {
            const cp = ch.codePointAt(0);
            if (!usage.has(cp)) usage.set(cp, new Set());
            usage.get(cp).add(rel);
        }
    }
}

check('site renders at least one flag (otherwise this suite is vacuous)',
    usage.size > 0 ? [] : ['no regional-indicator pairs found anywhere in the site']);

/* ---------- read the shipped font ---------- */

// woff2: 48-byte header, then a table directory of variable-length entries,
// then every table's bytes concatenated into one brotli stream. Tables are
// identified by a 6-bit index into a fixed list, so the directory has to be
// walked in order to learn where cmap starts.
const KNOWN_TAGS = [
    'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
    'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
    'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
    'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
    'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
    'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
    'Gloc', 'Feat', 'Sill',
];

function readBase128(buf, state) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
        const b = buf[state.p++];
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) return value >>> 0;
    }
    throw new Error('malformed UIntBase128');
}

function readTable(woff2, wanted) {
    if (woff2.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a woff2 file');
    const numTables = woff2.readUInt16BE(12);
    const state = { p: 48 };
    const dir = [];
    for (let i = 0; i < numTables; i++) {
        const flags = woff2[state.p++];
        const idx = flags & 0x3f;
        const transformVersion = (flags >> 6) & 0x03;
        let tag;
        if (idx === 63) {
            tag = woff2.toString('latin1', state.p, state.p + 4);
            state.p += 4;
        } else {
            tag = KNOWN_TAGS[idx];
        }
        const origLength = readBase128(woff2, state);
        // glyf/loca carry a transformLength when the version IS 0; every other
        // table carries one when it is NOT 0. Getting this backwards silently
        // shifts every subsequent table offset.
        const transformed = (tag === 'glyf' || tag === 'loca')
            ? transformVersion === 0
            : transformVersion !== 0;
        const length = transformed ? readBase128(woff2, state) : origLength;
        dir.push({ tag, length });
    }
    const font = zlib.brotliDecompressSync(woff2.subarray(state.p));
    let offset = 0;
    for (const entry of dir) {
        if (entry.tag === wanted) return font.subarray(offset, offset + entry.length);
        offset += entry.length;
    }
    return null;
}

// Only formats 4 and 12 appear in practice; flags live above U+FFFF so in
// practice it is 12, but reading both keeps this honest if the font is rebuilt.
function cmapCodepoints(cmap) {
    const out = new Set();
    const numTables = cmap.readUInt16BE(2);
    for (let i = 0; i < numTables; i++) {
        const offset = cmap.readUInt32BE(4 + i * 8 + 4);
        const format = cmap.readUInt16BE(offset);
        if (format === 12) {
            const nGroups = cmap.readUInt32BE(offset + 12);
            for (let g = 0; g < nGroups; g++) {
                const base = offset + 16 + g * 12;
                const start = cmap.readUInt32BE(base);
                const end = cmap.readUInt32BE(base + 4);
                for (let c = start; c <= end; c++) out.add(c);
            }
        } else if (format === 4) {
            const segX2 = cmap.readUInt16BE(offset + 6);
            for (let s = 0; s < segX2 / 2; s++) {
                const end = cmap.readUInt16BE(offset + 14 + s * 2);
                const start = cmap.readUInt16BE(offset + 16 + segX2 + s * 2);
                if (start === 0xffff) continue;
                for (let c = start; c <= end; c++) out.add(c);
            }
        }
    }
    return out;
}

const FONT_REL = 'fonts/TwemojiCountryFlags-subset.woff2';
const FONT_ABS = path.join(ROOT, FONT_REL);

check(`${FONT_REL} is committed`,
    fs.existsSync(FONT_ABS) ? [] : [`missing — the flags fall back to letters on Windows without it`]);

let covered = new Set();
if (fs.existsSync(FONT_ABS)) {
    try {
        const cmap = readTable(fs.readFileSync(FONT_ABS), 'cmap');
        covered = cmap ? cmapCodepoints(cmap) : new Set();
        check('font exposes a readable cmap',
            covered.size > 0 ? [] : ['parsed the font but found no mapped codepoints']);
    } catch (err) {
        check('font parses as woff2', [err.message]);
    }
}

/* ---------- the checks that matter ---------- */

check('every flag the site uses is in the shipped font',
    [...usage.entries()]
        .filter(([cp]) => !covered.has(cp))
        .map(([cp, files]) => `${hex(cp)} used in ${[...files].sort().slice(0, 3).join(', ')}`
            + (files.size > 3 ? ` (+${files.size - 3} more)` : '')
            + ' — regenerate the subset with this codepoint included'));

check('every page rendering a flag loads the flag font', (() => {
    const problems = [];
    const pages = new Set();
    for (const file of [...filesWithFlags].sort()) {
        const host = HOST_PAGE.find((h) => h.match(file));
        if (!host) {
            problems.push(`${file} has flags but no known host page — add it to HOST_PAGE `
                + `and make sure that page declares the @font-face`);
            continue;
        }
        pages.add(host.page);
    }
    for (const page of [...pages].sort()) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        if (!html.includes(FONT_REL)) {
            problems.push(`${page} renders flags but never references ${FONT_REL}`);
        } else if (!/@font-face[^}]*Twemoji Country Flags/s.test(html)) {
            problems.push(`${page} references the font file but declares no matching @font-face`);
        } else if (!/font-family:\s*'Twemoji Country Flags'\s*,/.test(html)) {
            problems.push(`${page} declares the @font-face but never puts 'Twemoji Country Flags' `
                + `first in a font-family stack, so the system font still wins`);
        }
    }
    return problems;
})());

check('@font-face unicode-range covers the regional indicator block', (() => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/unicode-range:\s*([^;]+);/);
    if (!m) return ['no unicode-range on the @font-face — the font would be consulted for all text'];
    const range = m[1].trim().toUpperCase();
    return range === 'U+1F1E6-1F1FF'
        ? []
        : [`unicode-range is "${range}"; expected U+1F1E6-1F1FF (the regional indicator block). `
            + `Too narrow silently drops flags; too wide lets this font supply non-flag glyphs.`];
})());

console.log();
if (failures) {
    console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
    process.exit(1);
}
console.log(`\x1b[32mall ${checks} checks passed\x1b[0m`);

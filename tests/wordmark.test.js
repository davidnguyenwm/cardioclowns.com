/*
 * Wordmark tests. Run: node tests/wordmark.test.js
 *
 * WHY THIS EXISTS
 *
 * The hero heading is no longer text. It is an SVG of outlined letterforms,
 * because the logotype is set in SF Rounded — an Apple system font that cannot
 * be served to a browser and does not exist on Windows or Android. Live text
 * would fall back to Helvetica for most of the web and quietly stop being the
 * logotype.
 *
 * That trade buys fidelity and costs three things a normal heading gets free,
 * none of which fail loudly:
 *
 *   - The file has to exist. A background-image 404 renders as nothing at all:
 *     the hero keeps its layout and simply has no title, and every automated
 *     check that greps the HTML for "Cardio Clowns" still passes because the
 *     name is in the markup.
 *   - The box has to match the art. The width and aspect-ratio are set in CSS
 *     while the proportions live in the SVG's viewBox; edit one and the
 *     wordmark letterboxes or crops with nothing to catch it.
 *   - The name has to survive for anything that reads text rather than
 *     pictures — screen readers, search engines, link previews.
 *
 * Dependency-free, like the rest of this directory.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* The four variants the brand kit ships. Every one is referenced by
   brand/README.md as available, so every one has to actually be there. */
const VARIANTS = ['light', 'dark', 'mono-white', 'mono-black'];

console.log(`wordmark · ${VARIANTS.length} variants`);
console.log();

check('every wordmark variant is present', (() => {
    const problems = [];
    for (const v of VARIANTS) {
        const file = path.join(ROOT, 'brand', `cardio-clowns-wordmark-${v}.svg`);
        if (!fs.existsSync(file)) {
            problems.push(`brand/cardio-clowns-wordmark-${v}.svg is missing — regenerate with scripts/wordmark_export.swift in the app repo`);
        }
    }
    return problems;
})());

check('the wordmarks are outlined paths, not live text', (() => {
    // A `<text>` element would render in SF Rounded on the Mac it was authored
    // on and in Helvetica everywhere else — the exact failure the outlines
    // exist to prevent, and one that is invisible to the author.
    const problems = [];
    for (const v of VARIANTS) {
        const file = path.join(ROOT, 'brand', `cardio-clowns-wordmark-${v}.svg`);
        if (!fs.existsSync(file)) continue;
        const svg = fs.readFileSync(file, 'utf8');
        if (/<text[\s>]/.test(svg)) problems.push(`${v}.svg contains a <text> element`);
        if (!svg.includes('<path')) problems.push(`${v}.svg has no path data`);
        if (!svg.includes('aria-label="Cardio Clowns"')) {
            problems.push(`${v}.svg has no accessible name`);
        }
    }
    return problems;
})());

check('the hero heading renders the wordmark', (() => {
    const problems = [];
    const rule = html.match(/\.cc-hero h1 \{([^}]*)\}/);
    if (!rule) return ['no `.cc-hero h1` rule found — has the hero changed shape?'];
    if (!/background:[^;]*cardio-clowns-wordmark-[\w-]+\.svg/.test(rule[1])) {
        problems.push('.cc-hero h1 no longer paints a wordmark SVG');
    }
    return problems;
})());

check('the hero uses the mono variant, not a colour ramp', (() => {
    // The hero is a vivid three-stop gradient. Neither colour ramp is legible
    // across all of it; that is what the mono variant is for, and swapping in
    // a prettier one is an easy mistake to make on a screenshot of the top of
    // the page.
    const rule = html.match(/\.cc-hero h1 \{([^}]*)\}/);
    if (!rule) return ['no `.cc-hero h1` rule found'];
    const variant = rule[1].match(/cardio-clowns-wordmark-([\w-]+)\.svg/);
    if (!variant) return ['no wordmark in the hero rule'];
    return variant[1].startsWith('mono')
        ? []
        : [`the hero paints the "${variant[1]}" variant over a vivid gradient; use mono-white`];
})());

check('every wordmark the page references actually exists', (() => {
    const problems = [];
    for (const m of html.matchAll(/cardio-clowns-wordmark-([\w-]+)\.svg/g)) {
        const file = path.join(ROOT, 'brand', `cardio-clowns-wordmark-${m[1]}.svg`);
        if (!fs.existsSync(file)) {
            problems.push(`index.html references ${m[0]}, which is not in brand/`);
        }
    }
    return problems;
})());

check('the CSS aspect-ratio matches the art', (() => {
    // The box is declared in CSS, the proportions live in the viewBox. Drift
    // letterboxes the mark or crops it, and `contain` makes that silent.
    const rule = html.match(/\.cc-hero h1 \{([^}]*)\}/);
    if (!rule) return ['no `.cc-hero h1` rule found'];

    const declared = rule[1].match(/aspect-ratio:\s*([\d.]+)/);
    if (!declared) return ['.cc-hero h1 declares no aspect-ratio, so the box height is unpredictable'];

    const variant = rule[1].match(/cardio-clowns-wordmark-([\w-]+)\.svg/);
    const file = path.join(ROOT, 'brand', `cardio-clowns-wordmark-${variant[1]}.svg`);
    if (!fs.existsSync(file)) return [];   // covered by the existence check

    const viewBox = fs.readFileSync(file, 'utf8').match(/viewBox="([^"]+)"/);
    if (!viewBox) return [`${variant[1]}.svg has no viewBox`];

    const [, , w, h] = viewBox[1].trim().split(/\s+/).map(Number);
    const actual = w / h;
    const drift = Math.abs(actual - Number(declared[1]));
    return drift <= 0.05
        ? []
        : [`CSS says aspect-ratio ${declared[1]}, the art is ${actual.toFixed(2)} — the wordmark will letterbox or crop`];
})());

check('the name survives for readers that do not see pictures', (() => {
    // Screen readers, search engines and link previews all read text. The
    // wordmark only does the showing.
    const problems = [];
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (!h1) return ['the hero has no <h1> at all'];
    if (!h1[1].includes('Cardio Clowns')) {
        problems.push('the hero <h1> no longer contains the words "Cardio Clowns"');
    }
    if (!/class="[^"]*cc-visually-hidden/.test(h1[1])) {
        problems.push('the hero <h1> text is not marked visually-hidden, so it will print on top of the wordmark');
    }
    if (!/\.cc-visually-hidden\s*\{/.test(html)) {
        problems.push('.cc-visually-hidden is used but never defined');
    }
    return problems;
})());

check('no breakpoint sizes the wordmark with font-size', (() => {
    // The heading has no text left, so font-size is inert there. A leftover
    // rule looks like it is doing something and is not.
    const problems = [];
    for (const m of html.matchAll(/\.cc-hero h1 \{([^}]*)\}/g)) {
        if (/font-size/.test(m[1])) {
            problems.push(`a .cc-hero h1 rule still sets font-size: "${m[1].trim()}" — set width instead`);
        }
    }
    return problems;
})());

/* ---------- the Open Graph banner ---------- */

/* PNG dimensions straight out of the IHDR chunk. Dependency-free, like the
   rest of this directory: 8-byte signature, then a 4-byte length, "IHDR", and
   width/height as big-endian uint32s. */
function pngSize(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

check('the Open Graph banner is present and the declared size', (() => {
    // This is the image every invite previews with. The app attaches no link
    // metadata of its own, so Messages and WhatsApp build their card from the
    // join page's og: tags — this picture is the first thing a new player sees.
    const problems = [];
    const file = path.join(ROOT, 'og-image.png');
    if (!fs.existsSync(file)) return ['og-image.png is missing'];

    const size = pngSize(file);
    if (!size) return ['og-image.png is not a readable PNG'];
    if (size.width !== 1200 || size.height !== 630) {
        problems.push(`og-image.png is ${size.width}×${size.height}; Open Graph wants 1200×630`);
    }
    return problems;
})());

check('every page declares the banner size the file actually is', (() => {
    // og:image:width / height are a promise to the previewing client. When they
    // disagree with the file, the card letterboxes or is dropped — and nothing
    // on our side errors.
    const problems = [];
    const size = pngSize(path.join(ROOT, 'og-image.png'));
    if (!size) return [];

    for (const page of ['index.html', 'join/index.html', 'press/index.html']) {
        const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
        if (!src.includes('og-image.png')) continue;
        const w = src.match(/og:image:width"\s+content="(\d+)"/);
        const h = src.match(/og:image:height"\s+content="(\d+)"/);
        if (w && Number(w[1]) !== size.width) {
            problems.push(`${page} declares og:image:width ${w[1]}, the file is ${size.width}`);
        }
        if (h && Number(h[1]) !== size.height) {
            problems.push(`${page} declares og:image:height ${h[1]}, the file is ${size.height}`);
        }
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

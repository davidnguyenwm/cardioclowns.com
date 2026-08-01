/*
 * Shared language engine for cardioclowns.com.
 *
 * Pages ship their English copy in the markup and mark the translatable bits
 * with data-i18n attributes. Every other language is a JSON file holding only
 * the strings, so a visitor downloads their own language and nothing else.
 *
 * Language is picked automatically from the browser/device setting, which on
 * iOS and macOS follows the system language. Two escapes, for testing and for
 * anyone who wants a different one: ?lang=<code> in the URL, and the picker
 * (remembered in localStorage until set back to Auto). The stored choice is
 * shared across pages, so picking German here keeps German over there.
 *
 * Usage:
 *   <script src="/lang.js"></script>
 *   <script>CCLang.init({ dir: '/i18n/' });</script>
 *
 * Attributes:
 *   data-i18n        textContent
 *   data-i18n-html   innerHTML (for copy containing <strong>, <em>, links)
 *   data-i18n-alt    alt=""
 *   data-i18n-label  aria-label=""
 */
(function (global) {
    'use strict';

    // Native names, so the picker is readable in the language it selects.
    // Order matches the app's own language list. Adding a language here means
    // adding <code>.json to every page's i18n directory.
    var LANGS = [
        ['en', 'English'],
        ['es', 'Español'],
        ['fr', 'Français'],
        ['it', 'Italiano'],
        ['pt-BR', 'Português (Brasil)'],
        ['ca', 'Català'],
        ['de', 'Deutsch'],
        ['nl', 'Nederlands'],
        ['sv', 'Svenska'],
        ['da', 'Dansk'],
        ['nb', 'Norsk bokmål'],
        ['fi', 'Suomi'],
        ['ja', '日本語'],
        ['zh-Hans', '简体中文'],
        ['zh-Hant', '繁體中文'],
        ['ko', '한국어'],
        ['ru', 'Русский'],
        ['uk', 'Українська'],
        ['pl', 'Polski'],
        ['cs', 'Čeština'],
        ['sk', 'Slovenčina'],
        ['hr', 'Hrvatski'],
        ['sl', 'Slovenščina'],
        ['hu', 'Magyar'],
        ['ro', 'Română'],
        ['el', 'Ελληνικά'],
        ['tr', 'Türkçe'],
        ['th', 'ไทย'],
        ['id', 'Bahasa Indonesia'],
        ['ms', 'Bahasa Melayu'],
        ['vi', 'Tiếng Việt'],
        ['ar', 'العربية'],
        ['he', 'עברית'],
        ['ur', 'اردو'],
        ['hi', 'हिन्दी'],
        ['bn', 'বাংলা'],
        ['mr', 'मराठी'],
        ['gu', 'ગુજરાતી'],
        ['pa', 'ਪੰਜਾਬੀ'],
        ['ta', 'தமிழ்'],
        ['te', 'తెలుగు'],
        ['kn', 'ಕನ್ನಡ'],
        ['ml', 'മലയാളം'],
        ['or', 'ଓଡ଼ିଆ']
    ];

    var RTL = { ar: 1, he: 1, ur: 1 };
    // Retired ISO codes that some systems still report.
    var LEGACY = { iw: 'he', in: 'id' };
    var STORE_KEY = 'cc-lang';

    function isKnown(code) {
        for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === code) return true;
        return false;
    }

    // Map a browser/BCP-47 tag onto one of our language files. Exact match
    // first (pt-BR, zh-Hans), then case-insensitive, then the script/region-
    // stripped base (es-419 -> es, zh-TW -> zh-Hant).
    function resolve(raw) {
        if (!raw) return null;
        if (isKnown(raw)) return raw;
        var lower = String(raw).toLowerCase();
        for (var i = 0; i < LANGS.length; i++) {
            if (LANGS[i][0].toLowerCase() === lower) return LANGS[i][0];
        }
        var base = lower.split('-')[0];
        if (LEGACY[base]) return LEGACY[base];
        // Chinese needs script inference: the tag usually carries a region
        // rather than Hans/Hant.
        if (base === 'zh') return /hant|tw|hk|mo/.test(lower) ? 'zh-Hant' : 'zh-Hans';
        // Norwegian: no/nn/nb all land on the one file we ship.
        if (base === 'nn' || base === 'no') return 'nb';
        for (var j = 0; j < LANGS.length; j++) {
            if (LANGS[j][0].toLowerCase().split('-')[0] === base) return LANGS[j][0];
        }
        return null;
    }

    // First browser preference we actually have a file for — not just
    // navigator.language, so a device set to [ga, fr, en] gets French rather
    // than English.
    function fromBrowser() {
        var list = navigator.languages && navigator.languages.length
            ? navigator.languages
            : [navigator.language];
        for (var i = 0; i < list.length; i++) {
            var hit = resolve(list[i]);
            if (hit) return hit;
        }
        return 'en';
    }

    var SLOTS = [
        ['data-i18n', function (el) { return el.textContent; }, function (el, v) { el.textContent = v; }],
        ['data-i18n-html', function (el) { return el.innerHTML; }, function (el, v) { el.innerHTML = v; }],
        ['data-i18n-alt', function (el) { return el.getAttribute('alt'); }, function (el, v) { el.setAttribute('alt', v); }],
        ['data-i18n-label', function (el) { return el.getAttribute('aria-label'); }, function (el, v) { el.setAttribute('aria-label', v); }]
    ];

    function init(opts) {
        opts = opts || {};
        var dir = opts.dir || '/i18n/';

        // A page may show more than one picker — the homepage has one in the
        // hero (visible on landing) and one in the sticky nav (reachable after
        // you scroll past the hero). They are kept in sync below.
        var selects = document.querySelectorAll(opts.selector || '[data-lang-picker]');
        if (!selects.length) {
            var legacy = document.getElementById(opts.selectId || 'lang-select');
            selects = legacy ? [legacy] : [];
        }

        // Snapshot the English already in the DOM. Switching back to English
        // restores from this, so English is never duplicated into a JSON file
        // that could drift from the markup.
        var EN = { title: document.title };
        SLOTS.forEach(function (slot) {
            var nodes = document.querySelectorAll('[' + slot[0] + ']');
            for (var i = 0; i < nodes.length; i++) {
                var key = nodes[i].getAttribute(slot[0]);
                if (!(key in EN)) EN[key] = slot[1](nodes[i]);
            }
        });

        function apply(code, strings) {
            SLOTS.forEach(function (slot) {
                var nodes = document.querySelectorAll('[' + slot[0] + ']');
                for (var i = 0; i < nodes.length; i++) {
                    var key = nodes[i].getAttribute(slot[0]);
                    // Fall back per-string, not per-page: a key missing from a
                    // translation shows English rather than blank.
                    var value = strings[key] != null ? strings[key] : EN[key];
                    if (value != null) slot[2](nodes[i], value);
                }
            });
            document.title = strings.title != null ? strings.title : EN.title;
            document.documentElement.lang = code;
            document.documentElement.dir = RTL[code] ? 'rtl' : 'ltr';

            // Let a page react to the language beyond swapping strings — the
            // press page listens so it can switch to that market's screenshots
            // and preview video. Pages that don't listen are unaffected.
            try {
                document.dispatchEvent(new CustomEvent('cc:lang', { detail: { lang: code } }));
            } catch (e) { /* no CustomEvent constructor: strings are still applied */ }
        }

        var current = 'en';

        function show(code) {
            current = code;
            if (code === 'en') { apply('en', EN); return; }
            fetch(dir + code + '.json', { cache: 'no-cache' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (strings) {
                    // A slow file that lost a race with a later click must not
                    // overwrite the language now on screen.
                    if (current === code) apply(code, strings);
                })
                .catch(function () {
                    // Missing or unreachable translation: English is already on
                    // the page, so there is nothing to undo.
                    if (current === code) apply('en', EN);
                });
        }

        // Build every picker. "Auto" is the default and means "follow the
        // device" — choosing a language pins it, choosing Auto unpins.
        function fill(select) {
            var auto = document.createElement('option');
            auto.value = '';
            auto.textContent = opts.autoLabel || 'Auto (system)';
            select.appendChild(auto);
            for (var i = 0; i < LANGS.length; i++) {
                var opt = document.createElement('option');
                opt.value = LANGS[i][0];
                opt.textContent = LANGS[i][1];
                select.appendChild(opt);
            }
        }
        for (var s = 0; s < selects.length; s++) fill(selects[s]);

        var stored = null;
        try { stored = localStorage.getItem(STORE_KEY); } catch (e) { /* private mode */ }
        if (stored && !isKnown(stored)) stored = null;

        // ?lang= wins over opts.lang (a page-supplied default, used by the
        // press page's ?m=<market> deep links), which wins over a stored pick,
        // which wins over the device.
        var forced = resolve(new URLSearchParams(location.search).get('lang'));
        var pinned = forced || resolve(opts.lang) || stored;

        function setAll(value) {
            for (var i = 0; i < selects.length; i++) selects[i].value = value;
        }
        setAll(pinned || '');

        for (var k = 0; k < selects.length; k++) {
            selects[k].addEventListener('change', function () {
                var value = this.value;
                try {
                    if (value) localStorage.setItem(STORE_KEY, value);
                    else localStorage.removeItem(STORE_KEY);
                } catch (e) { /* private mode */ }
                // Move the other pickers with this one so they never disagree.
                setAll(value);
                show(value || fromBrowser());
            });
        }

        show(pinned || fromBrowser());
    }

    global.CCLang = {
        LANGS: LANGS,
        resolve: resolve,
        fromBrowser: fromBrowser,
        isRTL: function (code) { return !!RTL[code]; },
        init: init
    };
})(window);

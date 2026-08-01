/*
 * Localized media for cardioclowns.com.
 *
 * The App Store screenshots and preview video exist for every language the
 * site speaks, so a visitor sees the app in their own language rather than
 * translated copy wrapped around English screenshots. This maps a language
 * onto its App Store locale folder and swaps the assets in place.
 *
 * Pair it with lang.js, which fires `cc:lang` whenever the language changes:
 *
 *   <script src="/lang.js"></script>
 *   <script src="/media.js"></script>
 *   <script>
 *     document.addEventListener('cc:lang', function (e) {
 *       CCMedia.apply(CCMedia.localeFor(e.detail.lang));
 *     });
 *     CCLang.init({ dir: '/i18n/' });
 *   </script>
 *
 * Markup it looks for (all optional):
 *   <img data-shot="iphone-leaderboard">   -> /media/shots/<locale>/<name>.png
 *   <video data-preview-video>             -> /media/preview/<locale>.mp4 + .jpg
 *   <a data-preview-dl>                    -> /media/preview/<locale>.mp4
 */
(function (global) {
    'use strict';

    // Language code (see lang.js LANGS) -> App Store locale folder. The folder
    // names come from App Store Connect, so several don't match their language
    // code: nb -> no, sl -> sl-SI, ur -> ur-PK, ar -> ar-SA, the Indic *-IN set.
    var LANG_ASSETS = {
        en: 'en-US',      es: 'es-ES',      fr: 'fr-FR',    it: 'it',
        'pt-BR': 'pt-BR', ca: 'ca',         de: 'de-DE',    nl: 'nl-NL',
        sv: 'sv',         da: 'da',         nb: 'no',       fi: 'fi',
        ja: 'ja',         'zh-Hans': 'zh-Hans',             'zh-Hant': 'zh-Hant',
        ko: 'ko',         ru: 'ru',         uk: 'uk',       pl: 'pl',
        cs: 'cs',         sk: 'sk',         hr: 'hr',       sl: 'sl-SI',
        hu: 'hu',         ro: 'ro',         el: 'el',       tr: 'tr',
        th: 'th',         id: 'id',         ms: 'ms',       vi: 'vi',
        ar: 'ar-SA',      he: 'he',         ur: 'ur-PK',    hi: 'hi',
        bn: 'bn-BD',      mr: 'mr-IN',      gu: 'gu-IN',    pa: 'pa-IN',
        ta: 'ta-IN',      te: 'te-IN',      kn: 'kn-IN',    ml: 'ml-IN',
        or: 'or-IN'
    };

    var BASE = '/media/';
    var FALLBACK = 'en-US';

    function localeFor(lang) {
        return (lang && LANG_ASSETS[lang]) || FALLBACK;
    }

    function apply(locale) {
        if (!locale) locale = FALLBACK;

        var shots = document.querySelectorAll('[data-shot]');
        for (var i = 0; i < shots.length; i++) {
            shots[i].src = BASE + 'shots/' + locale + '/' + shots[i].getAttribute('data-shot') + '.png';
        }

        var videos = document.querySelectorAll('[data-preview-video]');
        for (var v = 0; v < videos.length; v++) {
            var video = videos[v];
            var source = video.querySelector('source');
            if (!source) continue;
            var playing = !video.paused;
            video.poster = BASE + 'preview/' + locale + '.jpg';
            source.src = BASE + 'preview/' + locale + '.mp4';
            video.load();                       // required after swapping <source>
            if (playing) { video.play().catch(function () { /* autoplay blocked */ }); }
        }

        var links = document.querySelectorAll('[data-preview-dl]');
        for (var d = 0; d < links.length; d++) {
            links[d].href = BASE + 'preview/' + locale + '.mp4';
        }
    }

    global.CCMedia = {
        LANG_ASSETS: LANG_ASSETS,
        localeFor: localeFor,
        apply: apply
    };
})(window);

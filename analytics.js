/*
 * analytics.js — cookieless page-view analytics for cardioclowns.com.
 *
 * The website was the one part of the funnel with no measurement at all. That
 * mattered most on /join: an invite link opened by someone who doesn't have
 * the app lands there, and until now nobody could see how many of those
 * landings happened, let alone how many turned into downloads. Page views here
 * plus the `ct=` campaign tokens in appstore.js close that gap from both ends.
 *
 * Cloudflare Web Analytics is used because it fits what the privacy policy
 * promises: no cookies, no localStorage, no cross-site identifiers, no
 * fingerprinting, no advertising, and nothing sold on. It measures pages, not
 * people.
 *
 * TO GO LIVE:
 *   Replace CF_BEACON_TOKEN with the token from the Cloudflare dashboard
 *   (Web Analytics → add cardioclowns.com → copy the token).
 *
 * Until then this file makes no network request of any kind — the beacon is
 * only injected once a real token is present, so the site ships zero
 * third-party requests in the meantime.
 */
(function () {
    'use strict';

    var TOKEN = 'CF_BEACON_TOKEN';
    var BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

    // A real token is a 32-character hex string. The placeholder isn't, which
    // is what keeps this inert until someone fills it in.
    if (!/^[0-9a-f]{32}$/i.test(TOKEN)) return;

    /*
     * Respect an explicit "do not track" — a page view isn't worth ignoring
     * someone who asked not to be counted.
     *
     * Three spellings, because the signal was never standardised: '1' is what
     * Firefox and Chromium set, 'yes' is what Safari sent while it still had
     * the setting, and IE/old Edge hung it off navigator.msDoNotTrack. Reading
     * only navigator.doNotTrack === '1' silently counts people who did opt out.
     *
     * Global Privacy Control is the signal that actually still ships — Brave,
     * DuckDuckGo and Firefox send it, and unlike DNT it carries legal weight
     * under CCPA. A privacy policy that promises "measures pages, not people"
     * should honour the request people are actually making.
     */
    var dnt = [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack];
    for (var i = 0; i < dnt.length; i++) {
        if (dnt[i] === '1' || dnt[i] === 'yes') return;
    }
    if (navigator.globalPrivacyControl === true) return;

    // Two page views from one visit is worse than none — it silently doubles
    // every number on the dashboard. Cheap guard against this file being
    // included twice, which is a one-character mistake in a <head> block that
    // gets copied to every new page.
    if (document.querySelector('script[src="' + BEACON_SRC + '"]')) return;

    var script = document.createElement('script');
    script.defer = true;
    script.src = BEACON_SRC;
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: TOKEN }));
    document.head.appendChild(script);
})();

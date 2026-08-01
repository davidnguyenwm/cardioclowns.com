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

    // A real token is a 32-character hex string. The placeholder isn't, which
    // is what keeps this inert until someone fills it in.
    if (!/^[0-9a-f]{32}$/i.test(TOKEN)) return;

    // Respect an explicit "do not track" — a page view isn't worth ignoring
    // someone who asked not to be counted.
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

    var script = document.createElement('script');
    script.defer = true;
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: TOKEN }));
    document.head.appendChild(script);
})();

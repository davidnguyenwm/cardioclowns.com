/*
 * appstore.js — every App Store link on this site, built in one place, with
 * campaign attribution attached.
 *
 * Why this file exists: App Store Connect can tell you which campaign each
 * download came from, but only if the link carries `pt` (your provider token)
 * and `ct` (a campaign name you choose). Without them every download from
 * every source — the website, the invite page, the Instagram bio, a press
 * article — lands in one undifferentiated "Web Referrer" bucket, and the
 * question "which of the things we did actually drove installs?" has no
 * answer.
 *
 * Adding the tokens later doesn't recover the history, so the plumbing goes in
 * before launch and the two placeholders below are the only thing left to
 * swap.
 *
 * TO GO LIVE: flip `LAUNCHED` to true and deploy. That is the whole step.
 *
 * It is the whole step because everything else is done from that flag at
 * runtime: the "Coming soon" spans become campaign-tagged `<a>` download
 * buttons in the visitor's language, and the Smart App Banner picks up its
 * affiliate data. No markup edit, no second file, nothing to remember at the
 * one moment there is least attention to spare.
 *
 * PROVIDER_TOKEN below is not launch-day work and cannot be: App Store Connect
 * answers "This app is currently unavailable for Analytics" until the app has
 * been released, and the campaign link carrying `pt` is generated inside App
 * Analytics. So it is the first thing to fill in once live, not a prerequisite
 * — every install before then reports as an anonymous "Web Referrer" and never
 * backfills. CF_BEACON_TOKEN in analytics.js, by contrast, can be had today.
 * `node tests/launch-readiness.test.js` reports exactly what is still open and
 * fails hard if the flag flips with anything that could have been done first.
 *
 * The id and the launch moment are deliberately separate switches. Knowing the
 * App Store id is not the same as being on sale, and tying the two together
 * would mean pasting a ten-digit number into a live site under time pressure —
 * the worst possible moment to be editing anything. Everything below is already
 * real and verifiable in the console; `LAUNCHED` alone decides whether the
 * "Coming soon" CTAs become download links.
 *
 * PROVIDER_TOKEN is still a placeholder. It is NOT in Users and Access and NOT
 * in the App Store Connect API (both checked 2026-08-10): the only source is
 * App Store Connect → Analytics → Acquisition → Campaigns → create a campaign
 * link, then copy the numeric pt= value out of the generated URL. Digits only.
 * Links work without it, they just lose campaign attribution — and attribution
 * is not retroactive, so fill it in the day the app goes live.
 *
 * Verify the app is actually live before flipping — resultCount goes 0 → 1:
 *   https://itunes.apple.com/lookup?id=6761773257
 *
 * CAMPAIGN NAMES (keep these stable — ASC groups by exact string):
 *   web_home          the homepage download buttons
 *   web_join_invite   the invite page, opened from a real invite link
 *   web_join_direct   the invite page, opened without a group code
 *   web_press         the press kit
 *   ig_bio            Instagram profile link
 *   tiktok_bio        TikTok profile link
 *   yt_desc           YouTube description links
 * Anything published elsewhere should get its own name rather than reusing
 * one of these — a campaign that can't be told apart isn't measurable.
 *
 * SOURCE TOKENS (?c=)
 *
 * Press pitches link to /press/?c=en_macstories — one token per outlet — so an
 * install can be traced to the outlet that ran the link rather than to "the
 * press page" as a whole. `campaign()` folds that token onto a base name:
 * web_press + en_macstories -> web_press_en_macstories. Without it all 113
 * pitches report as one number, which answers "did press work?" but never
 * "which pitch worked?" — and re-pitching the same list next launch is a guess.
 *
 * Reading it is deliberately opt-in per page, NOT built into wireLinks by
 * default, because /join already uses `?c=` for something else entirely: there
 * it is the six-character group invite code. Folding that into a campaign name
 * would mint a fresh ASC campaign for every group ever created and publish
 * private invite codes into an analytics dashboard. Pages that want source
 * attribution ask for it; /join must never ask.
 */
(function (global) {
    'use strict';

    var APP_STORE_ID = '6761773257';
    var PROVIDER_TOKEN = '117881791';

    /** The one launch-day switch. See the header. */
    var LAUNCHED = false;

    /** The query parameter press links carry. See SOURCE TOKENS in the header. */
    var TOKEN_PARAM = 'c';

    /**
     * App Store Connect caps `ct` at 40 characters. The token cap below is 30
     * so that the longest base name that takes a token — `web_press`, 9
     * characters, plus the separator — lands exactly on 40 and never truncates.
     */
    var MAX_CAMPAIGN_LENGTH = 40;
    var MAX_TOKEN_LENGTH = 30;

    function isNumeric(value) {
        return /^[0-9]+$/.test(value);
    }

    /** True once the app is on sale and this site is meant to link to it. */
    function isLive() {
        return LAUNCHED && isNumeric(APP_STORE_ID);
    }

    /**
     * True when links carry the provider token App Store Connect needs to
     * report campaigns at all.
     *
     * Deliberately separate from isLive(): a download link with no `pt` still
     * works, it just lands in the anonymous "Web Referrer" bucket. Never break
     * a download over analytics — but say something, because that history is
     * not backfillable and the failure is otherwise completely silent.
     */
    function attributionReady() {
        return isNumeric(PROVIDER_TOKEN);
    }

    var warnedUnattributed = false;
    function warnIfUnattributed() {
        if (warnedUnattributed || !isLive() || attributionReady()) return;
        warnedUnattributed = true;
        if (global.console && global.console.warn) {
            global.console.warn(
                'appstore.js: PROVIDER_TOKEN is still a placeholder. Links work, but every ' +
                'install reports as an anonymous Web Referrer and the history cannot be ' +
                'backfilled. Set it from App Store Connect → Users and Access.'
            );
        }
    }

    /**
     * The per-outlet token from the current URL, or '' if there isn't a usable
     * one.
     *
     * Whitelisted rather than escaped, because this value is untrusted URL
     * input that ends up inside the Smart App Banner's `content` attribute —
     * a comma-separated field list. A token containing a comma would not
     * corrupt the campaign name, it would inject a *new banner field*
     * (`app-argument=`, `app-clip-bundle-id=`) from a link anyone can craft.
     * Anything outside [a-z0-9_] is therefore dropped whole, not cleaned up:
     * reporting a mangled link under its base campaign is honest, while
     * reporting it under a scrubbed lookalike invents attribution.
     */
    function sourceToken(search) {
        if (search === undefined) {
            search = (typeof location !== 'undefined' && location && location.search) || '';
        }
        var raw;
        try {
            raw = new URLSearchParams(search).get(TOKEN_PARAM) || '';
        } catch (e) {
            return '';
        }
        raw = raw.toLowerCase();
        return new RegExp('^[a-z0-9_]{1,' + MAX_TOKEN_LENGTH + '}$').test(raw) ? raw : '';
    }

    /**
     * A base campaign name with the URL's source token folded in, if it has
     * one: campaign('web_press') -> 'web_press_en_macstories'. Falls back to
     * the base name untouched, so a link with no token, or a junk one, still
     * reports — just less precisely.
     */
    function campaign(base, search) {
        var token = sourceToken(search);
        if (!token) return base;
        return (base + '_' + token).slice(0, MAX_CAMPAIGN_LENGTH);
    }

    /**
     * The App Store URL for a campaign. `mt=8` marks it as an iOS app link;
     * `pt`/`ct` are what App Store Connect attributes on.
     */
    function url(campaignName) {
        if (!isLive()) return null;
        warnIfUnattributed();
        var params = ['mt=8'];
        if (attributionReady()) params.push('pt=' + PROVIDER_TOKEN);
        if (campaignName) params.push('ct=' + encodeURIComponent(campaignName));
        return 'https://apps.apple.com/app/id' + APP_STORE_ID + '?' + params.join('&');
    }

    /**
     * Campaign attribution for the Smart App Banner, which uses its own
     * `affiliate-data` field rather than query parameters.
     */
    function affiliateData(campaignName) {
        var parts = [];
        if (attributionReady()) parts.push('pt=' + PROVIDER_TOKEN);
        // Second lock on the same door sourceToken() guards. Callers are
        // supposed to hand over a sanitised name, but this string is about to
        // become part of a comma-separated meta `content` list, so the value is
        // checked again where the damage would happen rather than trusted
        // across a function boundary.
        if (campaignName && /^[A-Za-z0-9_]+$/.test(campaignName)) parts.push('ct=' + campaignName);
        return parts.join('&');
    }

    /**
     * The URL handed to the app when it opens from the Smart App Banner, made
     * safe to sit inside the banner's comma-separated field list. Returns ''
     * for anything that isn't a plain https URL.
     *
     * The third lock on the door `sourceToken` and `affiliateData` guard, and
     * the one that was actually standing open: /join passes `location.href`,
     * which is the whole URL including whatever query anyone chose to put in
     * the link they sent. A comma is legal in a query string and browsers keep
     * it literal, so `?code=CLWNS7&x=,app-id=999999999` was not a mangled
     * app-argument — it was a *second* `app-id` field, appended to the banner
     * by whoever wrote the invite. The banner is how an invitee gets to the
     * App Store, so a link that can retarget it points them at another app
     * entirely.
     *
     * Commas are encoded rather than dropped: %2C round-trips back to a comma
     * through URLComponents in the app, so the deep link keeps working and the
     * invitee still lands on their group code. Nothing legitimate is lost.
     */
    function appArgument(raw) {
        if (!raw || typeof raw !== 'string') return '';
        if (!/^https:\/\/[^\s]+$/.test(raw)) return '';
        return raw.replace(/,/g, '%2C');
    }

    /**
     * Writes the Smart App Banner meta tag. `extra` carries the App Clip
     * fields the invite page needs; `appArgument` is the URL handed to the app
     * when it opens from the banner.
     */
    function smartBanner(options) {
        options = options || {};
        if (!isLive()) return;
        warnIfUnattributed();
        var content = ['app-id=' + APP_STORE_ID];
        if (options.clipBundleID) {
            content.push('app-clip-bundle-id=' + options.clipBundleID);
            content.push('app-clip-display=card');
        }
        var argument = appArgument(options.appArgument);
        if (argument) content.push('app-argument=' + argument);
        var affiliate = affiliateData(options.campaign);
        if (affiliate) content.push('affiliate-data=' + affiliate);

        var meta = document.querySelector('meta[name="apple-itunes-app"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'apple-itunes-app';
            document.head.appendChild(meta);
        }
        meta.content = content.join(', ');
    }

    /**
     * Turns one "Coming soon" placeholder into a real download button.
     *
     * Pre-launch the CTA is a `<span>` on purpose — not a link, not focusable,
     * and impossible to mistake for one by keyboard or screen reader. At launch
     * it has to become an `<a>`, and doing that here rather than by hand is the
     * difference between launch day being one boolean and launch day being a
     * boolean plus a markup edit that is invisible from the top of the page if
     * it's forgotten.
     *
     * The element is rebuilt rather than mutated because tagName is read-only:
     * attributes are copied, children are moved (the SVG and both labels keep
     * their identity, so lang.js can still find and translate them), and the
     * original is swapped out in place.
     */
    function activate(node) {
        var el = node;
        if (el.tagName !== 'A') {
            var link = document.createElement('a');
            for (var i = 0; i < el.attributes.length; i++) {
                link.setAttribute(el.attributes[i].name, el.attributes[i].value);
            }
            while (el.firstChild) link.appendChild(el.firstChild);
            if (el.parentNode) el.parentNode.replaceChild(link, el);
            el = link;
        }
        // cc-cta-soon is the "not a button yet" styling: no hover lift, default
        // cursor. Dropping it is what makes the live one look clickable.
        if (el.classList) el.classList.remove('cc-cta-soon');

        // Both labels ship in the markup; this picks the one that is true now.
        var labels = el.querySelectorAll('[data-cc-label]');
        for (var j = 0; j < labels.length; j++) {
            labels[j].hidden = labels[j].getAttribute('data-cc-label') !== 'live';
        }
        return el;
    }

    /**
     * Points every `[data-cc-campaign]` element on the page at the App Store,
     * each with its own campaign name, promoting the pre-launch placeholders to
     * real links on the way. Does nothing at all until LAUNCHED is true, so it
     * is safe to call — and is called — on every page load before launch.
     *
     * `options.sourceToken` folds the URL's `?c=` token into each name — pages
     * reached by a tokenised link opt in, /join must not. See SOURCE TOKENS.
     */
    function wireLinks(root, options) {
        if (!isLive()) return;
        var withToken = !!(options && options.sourceToken);
        var nodes = (root || document).querySelectorAll('[data-cc-campaign]');
        Array.prototype.forEach.call(nodes, function (node) {
            var name = node.getAttribute('data-cc-campaign');
            activate(node).href = url(withToken ? campaign(name) : name);
        });
    }

    global.CCStore = {
        isLive: isLive,
        attributionReady: attributionReady,
        url: url,
        campaign: campaign,
        sourceToken: sourceToken,
        affiliateData: affiliateData,
        smartBanner: smartBanner,
        wireLinks: wireLinks
    };
})(window);

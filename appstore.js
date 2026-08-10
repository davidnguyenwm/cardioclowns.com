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
 * TO GO LIVE:
 *   1. flip `LAUNCHED` to true, below
 *   2. swap the two `<span class="cc-cta cc-cta-soon">` on index.html for
 *      `<a class="cc-cta">`, keeping data-cc-campaign
 *   3. fill in PROVIDER_TOKEN here and CF_BEACON_TOKEN in analytics.js
 *   4. `node tests/launch-readiness.test.js` — it fails until all of the above
 *      is done, and passes with "cleared to deploy" when it is
 *
 * Step 2 is not optional and is easy to miss: wireLinks() skips anything that
 * isn't already an anchor, so flipping the flag alone leaves both download
 * buttons reading "Coming soon" underneath a working Smart App Banner. It looks
 * launched from the top of the page.
 *
 * The id and the launch moment are deliberately separate switches. Knowing the
 * App Store id is not the same as being on sale, and tying the two together
 * would mean pasting a ten-digit number into a live site under time pressure —
 * the worst possible moment to be editing anything. Everything below is already
 * real and verifiable in the console; `LAUNCHED` alone decides whether the
 * "Coming soon" CTAs become download links.
 *
 * PROVIDER_TOKEN is still a placeholder: App Store Connect → Users and Access →
 * the numeric "Provider ID"/campaign token. Links work without it, they just
 * lose campaign attribution — and attribution is not retroactive, so fill it in
 * before launch, not after.
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
    var PROVIDER_TOKEN = 'PROVIDER_TOKEN';

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
        if (options.appArgument) content.push('app-argument=' + options.appArgument);
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
     * Points every `<a data-cc-campaign="...">` on the page at the App Store,
     * each with its own campaign name. Elements that aren't links yet (the
     * "Coming soon" spans) are skipped, so this is safe to call before launch
     * and needs no second edit after the spans become anchors.
     *
     * `options.sourceToken` folds the URL's `?c=` token into each name — pages
     * reached by a tokenised link opt in, /join must not. See SOURCE TOKENS.
     */
    function wireLinks(root, options) {
        if (!isLive()) return;
        var withToken = !!(options && options.sourceToken);
        var nodes = (root || document).querySelectorAll('[data-cc-campaign]');
        Array.prototype.forEach.call(nodes, function (node) {
            if (node.tagName !== 'A') return;
            var name = node.getAttribute('data-cc-campaign');
            node.href = url(withToken ? campaign(name) : name);
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

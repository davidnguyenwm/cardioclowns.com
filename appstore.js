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
 */
(function (global) {
    'use strict';

    var APP_STORE_ID = '6761773257';
    var PROVIDER_TOKEN = 'PROVIDER_TOKEN';

    /** The one launch-day switch. See the header. */
    var LAUNCHED = false;

    function isNumeric(value) {
        return /^[0-9]+$/.test(value);
    }

    /** True once the app is on sale and this site is meant to link to it. */
    function isLive() {
        return LAUNCHED && isNumeric(APP_STORE_ID);
    }

    /**
     * The App Store URL for a campaign. `mt=8` marks it as an iOS app link;
     * `pt`/`ct` are what App Store Connect attributes on.
     */
    function url(campaign) {
        if (!isLive()) return null;
        var params = ['mt=8'];
        if (isNumeric(PROVIDER_TOKEN)) params.push('pt=' + PROVIDER_TOKEN);
        if (campaign) params.push('ct=' + encodeURIComponent(campaign));
        return 'https://apps.apple.com/app/id' + APP_STORE_ID + '?' + params.join('&');
    }

    /**
     * Campaign attribution for the Smart App Banner, which uses its own
     * `affiliate-data` field rather than query parameters.
     */
    function affiliateData(campaign) {
        var parts = [];
        if (isNumeric(PROVIDER_TOKEN)) parts.push('pt=' + PROVIDER_TOKEN);
        if (campaign) parts.push('ct=' + campaign);
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
     */
    function wireLinks(root) {
        if (!isLive()) return;
        var nodes = (root || document).querySelectorAll('[data-cc-campaign]');
        Array.prototype.forEach.call(nodes, function (node) {
            if (node.tagName !== 'A') return;
            node.href = url(node.getAttribute('data-cc-campaign'));
        });
    }

    global.CCStore = {
        isLive: isLive,
        url: url,
        affiliateData: affiliateData,
        smartBanner: smartBanner,
        wireLinks: wireLinks
    };
})(window);

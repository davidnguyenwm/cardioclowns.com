# cardioclowns.com
Cardio Clowns App
David Nguyen

## Download attribution

Every App Store link on this site is built by [`appstore.js`](appstore.js) so it
carries campaign attribution (`pt` = provider token, `ct` = campaign name).
Without those parameters App Store Connect files every web-driven download under
one anonymous "Web Referrer" bucket, and adding them later does not backfill the
history — so the plumbing is in place before launch and only the placeholders
need swapping.

### At launch — two values to replace

| File | Placeholder | Where to find it |
| --- | --- | --- |
| `appstore.js` | `APP_STORE_ID` | App Store Connect → App Information → Apple ID (numeric) |
| `appstore.js` | `PROVIDER_TOKEN` | App Store Connect → Users and Access → the numeric provider/campaign token |
| `analytics.js` | `CF_BEACON_TOKEN` | Cloudflare → Web Analytics → add cardioclowns.com → copy token |

Until `APP_STORE_ID` is a real number, `CCStore.isLive()` is false: links are
left alone, the Smart App Banner isn't written, and the "Coming soon" CTAs stay
as they are. Until `CF_BEACON_TOKEN` is a real 32-character token, the site
makes no third-party requests at all.

The homepage "Coming soon" spans carry `data-cc-campaign="web_home"`. At launch
they become `<a class="cc-cta" href="#">` — keep the attribute and `appstore.js`
fills in the href, campaign token included, so there's no chance of shipping an
untagged link.

### Campaign names

Keep these strings stable; App Store Connect groups on the exact value.

| `ct` | Where |
| --- | --- |
| `web_home` | Homepage download buttons |
| `web_join_invite` | `/join` opened from a real invite link (has a group code) |
| `web_join_direct` | `/join` opened without a code |
| `web_press` | Press kit |
| `ig_bio` | Instagram profile link |
| `tiktok_bio` | TikTok profile link |
| `yt_desc` | YouTube description links |

Anything published anywhere else should get its own name rather than reusing one
of these — a campaign that can't be told apart from another isn't measurable.

## Tests

```
node tests/press-locales.test.js
```

No dependencies and no package.json — plain Node against the checked-in files.
Exits non-zero on failure.

It checks that the press page's locale wiring is consistent across the three
places a language has to be registered: `press/i18n/*.json` (the copy),
`MARKETS` in `press/index.html` (the `?m=` codes), and `LANG_ASSETS` in
`media.js` (the screenshot and video folders).

Worth running because none of these failures surface at runtime. `?m=` falls
back to English on an unknown code **by design**, so that a junk URL still
renders a working page — which also means a half-registered language looks
identical to a correct one. Tamil shipped with copy at `press/i18n/ta.json` and
screenshots at `media/shots/ta-IN/` but no `MARKETS` entry, so
`/press?m=ta` quietly served English for weeks. Nothing threw and nothing 404'd.

The same gap caught Catalan, which cannot use `ca` because Canada owns that
code — hence the `cat` alias.

## Analytics

[`analytics.js`](analytics.js) adds cookieless page-view counting (Cloudflare Web
Analytics). It exists because `/join` is where invite links land for people who
don't have the app yet, and that step of the referral funnel was previously
invisible. It sets no cookies, uses no browser storage or cross-site
identifiers, and honours Do Not Track. The privacy policy describes it under
"This website".

## /stats — the private app dashboard

[`stats/index.html`](stats/index.html) is the same analytics the phone's hidden
Debug menu shows, on the web: engagement, the money funnel, the referral loop,
groups and geography, build adoption, permissions and the degraded paths. It
reads the app's own `AnalyticsEvent` records live from the CloudKit **public**
database over CloudKit Web Services and does every aggregation in the browser —
no server, no export step, no third-party analytics vendor, and every number is
a transcription of the reader of the same name in `AnalyticsManager.swift`.

It is not linked from anywhere, carries `noindex`, and is disallowed in
[`robots.txt`](robots.txt).

### First run

Open `/stats/` and fill in the one-time form:

1. **CloudKit API token** — CloudKit Console → the container → **switch the
   environment control beside the container name to the environment you want**
   → *Tokens & Keys* → **Add token**. Tokens are scoped to the environment they
   were created in: a Development token used against Production returns a flat
   `AUTHENTICATION_FAILED`, indistinguishable from a wrong token. Setting
   *Allowed Origins* to `cardioclowns.com` is worth doing — it makes the token
   useless anywhere but this page.
2. **Container** — pre-filled with `iCloud.com.davidnguyen.CardioClowns`.
3. **Environment** — *production* for App Store and TestFlight builds,
   *development* for debug builds run from Xcode.
4. **A password.**

After that the header carries a Production/Development switch, and the config
holds **one token per environment**, so switching never asks for a token you
already saved. The first time you switch to an environment with no token, the
page asks for that one token inline and remembers it. ⚙ shows both slots (each
masked to its last few characters) and takes a replacement for either.

No settings change re-prompts for the password: the key derived at unlock is
kept in memory for the life of the tab as a non-extractable `CryptoKey`, and
re-sealing reuses it with a fresh IV. Closing the tab drops it.

The token is encrypted with that password (AES-GCM, 600,000-round PBKDF2, random
salt and IV) before it is written to this browser's `localStorage`. The derived
key is never stored, so a reload asks for the password again. Nothing but the
CloudKit API ever receives the token.

### Using it on a second device

Either repeat the setup, or export the sealed config once (⚙ → *Export sealed
config…*), save the downloaded file as `stats/config.enc` and commit it. When
that file exists, every device only needs the password — the file itself is
ciphertext, so publishing it exposes nothing without the passphrase.

### If it can't read CloudKit

The error is shown in place. The two worth knowing:

- **401 / 403** — the API token was deleted or belongs to another container.
- **"clientTimestamp isn't queryable/sortable"** — the index is missing in that
  environment. Add it in the CloudKit Console and deploy the schema.

An empty dashboard usually means the wrong environment, not missing data.

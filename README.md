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

### At launch — four steps, in this order

1. Flip `LAUNCHED` to `true` in `appstore.js`.
2. Swap the two homepage `<span class="cc-cta cc-cta-soon">` for
   `<a class="cc-cta">`, keeping `data-cc-campaign`.
3. Replace the two placeholders below.
4. Run `node tests/launch-readiness.test.js` — it fails until 1–3 are all done
   and prints "cleared to deploy" when they are. **Then** deploy.

| File | Placeholder | Where to find it |
| --- | --- | --- |
| `appstore.js` | `APP_STORE_ID` | App Store Connect → App Information → Apple ID (numeric) — *already set* |
| `appstore.js` | `PROVIDER_TOKEN` | App Store Connect → Users and Access → the numeric provider/campaign token |
| `analytics.js` | `CF_BEACON_TOKEN` | Cloudflare → Web Analytics → add cardioclowns.com → copy token |

Step 2 is the one that bites. `wireLinks()` deliberately skips anything that
isn't already an anchor, so flipping `LAUNCHED` on its own ships a homepage whose
download buttons still read "Coming soon" — under a Smart App Banner that works
perfectly, which is what makes it easy to miss from the top of the page.

Until `LAUNCHED` is true, `CCStore.isLive()` is false: links are left alone, the
Smart App Banner isn't written, and the "Coming soon" CTAs stay as they are.
Until `CF_BEACON_TOKEN` is a real 32-character token, the site makes no
third-party requests at all.

A missing `PROVIDER_TOKEN` never breaks a download — analytics is not worth a
broken link — so the links keep working and every install lands in the anonymous
bucket instead. That failure is invisible and not backfillable, which is why it
is a launch-gate failure and a console warning rather than a silent degrade.

### Press links and `?c=`

Press pitches link to `/press/?c=<token>`, one token per outlet, so an install
traces back to the outlet that ran the link rather than to "the press page".
`CCStore.campaign('web_press')` folds the token into the campaign name —
`web_press_en_macstories`. Without it all 113 pitches report as a single number,
which answers "did press work" but never "which pitch worked".

Reading `?c=` is opt-in per page, and `/join` must never opt in: there `?c=` is
the six-character group invite code, and folding that into a campaign name would
mint an App Store Connect campaign per group ever created and publish private
invite codes into a dashboard. `tests/appstore.test.js` enforces this.

The token is whitelisted to `[a-z0-9_]{1,30}` rather than escaped, because it
ends up inside the Smart App Banner's comma-separated `content` attribute, where
a comma injects a *new field* (`app-argument=`) rather than corrupting a name.
Anything else is dropped whole — reporting a mangled link as plain `web_press`
is honest, while a scrubbed lookalike would be a confident wrong answer. The
token list lives in `outreach.json` in the app repo, and `scripts/outreach.py`
refuses to render a pitch whose token this site would drop.

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
node tests/run.js                        # everything
node tests/launch-readiness.test.js      # run this right after flipping LAUNCHED
```

No dependencies and no package.json — plain Node against the checked-in files.
Each suite is standalone and exits non-zero on failure.

| Suite | What it protects |
| --- | --- |
| `press-locales` | `?m=` locale wiring across i18n copy, `MARKETS` and `media.js` |
| `appstore` | campaign attribution: `?c=` tokens, `pt`/`ct`, banner injection, the `/join` collision |
| `analytics` | the beacon's first real execution: token gate, opt-out signals, per-page coverage |
| `launch-readiness` | the four launch steps above — green and quiet today, red the moment `LAUNCHED` flips with anything unfinished |

The common thread is that all four cover failures with no runtime symptom. The
press page falls back to English on an unknown `?m=`; a link with no `pt` still
downloads the app; an unset beacon token just counts nothing. Every one of them
looks exactly like success.

### press-locales

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

Opt-out is read in every spelling that ships: `navigator.doNotTrack` as `'1'`
(Chrome, Firefox) or `'yes'` (Safari, older Firefox), `window.doNotTrack`,
`navigator.msDoNotTrack`, and Global Privacy Control — which is the signal
browsers actually still send, and the one that carries legal weight under CCPA.
Reading only `navigator.doNotTrack === '1'` would have counted people who did
opt out, while the policy said otherwise.

Because the file is inert until the token is filled in, its entire body first
executes for real on launch day. `tests/analytics.test.js` runs that path now
instead — patching in a valid token to check the beacon's shape, and patching in
each opt-out signal to check it stays silent.

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

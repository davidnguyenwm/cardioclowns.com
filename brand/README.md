# Cardio Clowns wordmark

The logotype from the top of the leaderboard, exported for everywhere the app
can't reach: the website, press kits, social art, slides, print.

Regenerate with `swift scripts/wordmark_export.swift` — never edit these files by
hand. The app's own copy lives in `Cardio Clowns/Cardio Clowns/Wordmark.swift`;
if you change the colours or the tracking there, re-run the script.

## The one rule

**These are outlines, not text.** Do not retype "Cardio Clowns" in a font and
call it the logo.

The wordmark is set in SF Rounded, an Apple system font. It is not licensed to
be served to a browser and is not installed on Windows or Android, so live text
would fall back to Helvetica for most of the world and stop being the logotype.
The glyphs here are frozen as vector paths — no font file to ship, no licence
question, and the identical shape in every browser, in Figma, in Canva and on
paper.

## Which file

Aspect ratio is **7.33 : 1** (width : height). Clear space is already baked into
the viewBox, so you can butt the file straight up against other elements.

| File | Use it on |
|---|---|
| `cardio-clowns-wordmark-light.*` | Light backgrounds. Deep crimson→violet ramp. |
| `cardio-clowns-wordmark-dark.*` | Dark backgrounds. Vivid pink→purple ramp. |
| `cardio-clowns-wordmark-mono-white.*` | **Photos, video, vivid gradients, anything busy or unknown.** |
| `cardio-clowns-wordmark-mono-black.*` | One-colour print, embroidery, faxed press releases. |

Each comes as `.svg` (use this wherever you can) plus transparent `@800.png` and
`@1600.png` for the places that won't take SVG — some email clients, older slide
templates, a few of Apple's own marketing forms.

**When in doubt, reach for mono-white.** The two colour ramps are tuned for a
plain light or plain dark background. Over a photograph neither is reliable, and
a logo that is sometimes hard to read is worse than one that is always plain.

## Why there are two colour ramps

Contrast, measured rather than guessed. The app icon's own gradient is too light
to sit on a light background — its red end measures 3.4:1 on white and drops to
1.7:1 over the darkest in-app theme tint, under the 3:1 bar for large text. So
the light ramp is deepened (every stop held under 0.12 relative luminance) and
the dark ramp is lifted. Measured over all eleven in-app themes in both
appearances, the worst case is now 3.41:1.

If you place the wordmark on a background not covered here, measure it. Don't
assume.

## Web

```html
<picture>
  <source srcset="/brand/cardio-clowns-wordmark-dark.svg"
          media="(prefers-color-scheme: dark)">
  <img src="/brand/cardio-clowns-wordmark-light.svg"
       alt="Cardio Clowns" width="440" height="60">
</picture>
```

Set `width` and `height` (or `aspect-ratio: 7.33`) so the page doesn't reflow
while the SVG loads. Keep it at **120px wide or more** — below that the counters
in the "a" and the "o" start to fill in.

If it replaces a heading, keep the heading semantics and hide the duplicate text:

```html
<h1 class="cc-wordmark"><span class="visually-hidden">Cardio Clowns</span></h1>
```

```css
.cc-wordmark {
  background: url("/brand/cardio-clowns-wordmark-light.svg") no-repeat center / contain;
  aspect-ratio: 7.33;
  max-width: 440px;
  margin-inline: auto;
}
@media (prefers-color-scheme: dark) {
  .cc-wordmark { background-image: url("/brand/cardio-clowns-wordmark-dark.svg"); }
}
```

## Don't

- Don't retype it in a font, or in a "close enough" web font.
- Don't recolour it outside these four variants, or apply the gradient to
  "Cardio" as well — the two-tone split is the mark.
- Don't add a clown face, mascot or icon beside it. The app icon is the only
  face of the brand; a second drawn clown is a competing mark for the same
  thing. The app icon on its own, away from the wordmark, is fine.
- Don't stretch, skew, rotate, outline or add a drop shadow.
- Don't put the colour ramps on a busy background — that's what mono-white is
  for.

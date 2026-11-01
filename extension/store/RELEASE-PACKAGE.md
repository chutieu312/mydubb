# Images, screenshots and the release ZIP

Status: **icons prepared; screenshots, promo images and the release manifest wait for PR #45.**
The final Store screenshots must show the real single-page panel (three stacked blocks), so
nothing below may be captured from the two-tab build or from the PO's HTML mock-up.

## Sizes (Chrome documentation, read 2026-10-31)

Sources: `developer.chrome.com/docs/webstore/images`, `/docs/webstore/cws-dashboard-listing`,
`/docs/extensions/reference/manifest/icons`. The images page says "Last updated 2018-06-11" and
still describes downscaling to 640×400, so **re-check against the dashboard when uploading**.

| Asset | Requirement | Prepared |
|---|---|---|
| Store icon | 128×128 **PNG**, artwork 96×96 plus 16 px transparent padding per side; must look right on light and dark | Yes: `branding/png/icon-128.png` |
| Manifest icons | Always 128; 48 for the extensions page; 16 for extension-page favicons; 32 is in Chrome's example. PNG; SVG and WebP are **not** supported | Yes: 16, 32, 48, 128 |
| Screenshots | 1 required, up to 5; **1280×800** preferred (640×400 accepted); full bleed, square corners; show the real product | **No** (waiting for #45) |
| Small promo tile | 440×280, optional; "avoid text", brand-first, not a screenshot | No (optional) |
| Marquee promo tile | 1400×560, optional; needed only to be featured | No (optional) |
| Promo video | Optional YouTube link | No |

## Identity

- Name: MyDubb. Mark: an **M** whose middle stroke dips into a small audio wave (coral).
- Palette, from the Product Owner's approved single-page design: navy `#1a2e38` (panel `#101e27`),
  mint `#7be0c5`, coral `#f3a087`. Only these three in the icon.
- Two files so that it reads at 16 px: `branding/mydubb-icon.svg` (48 and 128) and
  `branding/mydubb-icon-small.svg` (16 and 32: thicker strokes, one coral bar).
- Not used: Udemy, Microsoft or Google marks, colours or shapes; the old blue-purple direction.
  Note: the **website's** current favicon (`frontend/public/favicon.svg`) and tokens are still the
  old blue (`#2a5bd7`); updating the website is outside this story.
- `branding/preview.png`: the PNGs at real size and enlarged on white, Chrome's light and dark
  frames, and the MyDubb dark and light panel backgrounds, for review.

Regenerate (from `extension/`, needs the Chromium of the Playwright install):

```sh
node store/tools/render-icons.mjs      # PNGs into store/branding/png/
node store/tools/render-preview.mjs    # store/branding/preview.png
```

The icons are **not referenced by the manifest or the panel yet** (that is the follow-up after
#45; adding `"icons"` and the files to `static/` then, plus the panel header mark that the design
shows).

## Screenshot plan (after #45 merges and its final build is verified)

Capture from the real extension, never a mock-up:

1. Build the **test** build (`node build.mjs --e2e`, fake MyDubb at `https://mydubb.test`, fixture
   lecture) in the existing Playwright harness; do not use the production server, Cognito, Azure
   or a real Udemy course. Text must be the permitted fixture text, with no account, e-mail or
   course name visible.
2. Set the viewport to 1280×800 with the panel at the real side-panel width on the right, the
   fixture lecture on the left. Save PNG, no alpha, no padding.
3. Shots (each must have a translation and loaded audio, never an empty panel):
   1. Transcript sent: **English transcript** block filled, times set.
   2. **Translate to** with language, voice, speed and **Generate audio**.
   3. **Your audio**: the translation above the player, **Loaded audio**.
   4. A newer result offered: **Use new audio** next to **Loaded audio**.
   5. **Sync with video** on, plus the floating player on the lecture.
4. Look at every image (readable at half size, no clipped text, light or dark consistent) before
   adding it, and keep them in `store/screenshots/` with the build SHA in the PR description.

Checklist before upload: five or fewer files, exact 1280×800, PNG, no personal data, no real
course content, no "unlimited"/price/guest/YouTube claim, panel shows the same labels as the
listing text.

## Release ZIP

```sh
cd extension
npm ci
npm run build                      # dist/, server https://mydubb.com
npm run check:dist
node store/tools/make-zip.mjs      # release/mydubb-extension-<version>.zip
```

- Only the files of `dist/` go in: `manifest.json` at the root, the four bundles, the panel and
  offscreen pages and CSS. No sources, tests, `dist-test`, `.map`, secrets or documents;
  `make-zip.mjs` refuses them and runs `check:dist` first. `release/` is git-ignored.
- `node store/tools/make-zip.mjs --release` also fails while the manifest has no 128 px icon, no
  release key, or still says "Prototype". **Today the ZIP is a draft and that check fails**, as it
  must: icons, name and key are not integrated.
- Version and dependencies: version from `static/manifest.json` (0.3.0 today; each upload needs a
  higher one). Node ≥ 22, `npm ci` from the lockfile, esbuild 0.28.2; the build bundles
  everything, so the ZIP has no runtime dependency and loads no remote code.
- Do not overwrite or delete the folder Chrome has loaded unpacked. Build into a new copy of the
  repository or take the ZIP from `release/`, and load it from a different folder only after
  reading [STABLE-ID.md](STABLE-ID.md).

## Not release-ready until

#45 is merged and its UI verified; the manifest has icons, the final name and description and the
verified key; `check:dist` has its release mode; the screenshots exist; the policy URL, support
contact and publisher details are provided; the Product Owner has decided about the reviewer test
account ([LISTING.md](LISTING.md)).

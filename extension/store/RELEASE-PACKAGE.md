# Images, screenshots and the release ZIP

Current release candidate: **0.5.0**, built in the separate `dist-release/` directory, with
the verified existing Store ID ([STABLE-ID.md](STABLE-ID.md)). The 0.4.1 package remains
Published - unlisted; 0.5.0 is a draft. See [LISTING.md](LISTING.md) for submission copy
with extension guests disabled. Historical checks below do not establish current Store status.

## Sizes (Chrome documentation, read 2026-10-31)

Sources: `developer.chrome.com/docs/webstore/images`, `/docs/webstore/cws-dashboard-listing`,
`/docs/extensions/reference/manifest/icons`. The images page says "Last updated 2018-06-11" and
still describes downscaling to 640×400, so **re-check against the dashboard when uploading**.

| Asset | Requirement | State |
|---|---|---|
| Store icon | 128×128 **PNG**, artwork 96×96 plus 16 px transparent padding per side; must look right on light and dark | `branding/png/icon-128.png`, in the manifest |
| Manifest icons | Always 128; 48 for the extensions page; 16 for extension-page favicons; 32 is in Chrome's example. PNG; SVG and WebP are **not** supported | 16, 32, 48, 128 in `icons`; the toolbar (`action.default_icon`) names 16 and 32 |
| Screenshots | 1 required, up to 5; **1280×800** preferred (640×400 accepted); full bleed, square corners; show the real product | Four, 1280×800 PNG, [screenshots/](screenshots/) |
| Small promo tile | 440×280, optional; "avoid text", brand-first, not a screenshot | Not made (optional) |
| Marquee promo tile | 1400×560, optional; needed only to be featured | Not made (optional) |
| Promo video | Optional YouTube link | No |

## Identity

- Name: MyDubb. Mark: an **M** whose middle stroke dips into a small audio wave (coral).
- Palette, from the Product Owner's approved single-page design: navy `#1a2e38` (panel `#101e27`),
  mint `#7be0c5`, coral `#f3a087`. Only these three in the icon.
- Two SVG masters so that it reads at 16 px: `branding/mydubb-icon.svg` (48 and 128) and
  `branding/mydubb-icon-small.svg` (16 and 32).
- Not used: Udemy, Microsoft or Google marks, colours or shapes; the old blue-purple direction.
  The **website's** favicon (`frontend/public/favicon.svg`) and the panel header still have no
  MyDubb mark and the favicon is the old blue; changing them is outside this story.
- `branding/preview.png`: the icons at real size and enlarged on white, Chrome's light and dark
  frames and MyDubb's two panel backgrounds.
- The build copies `store/branding/png/` to `icons/` in the package (one source of the PNGs).

Regenerate icons and preview (from `extension/`, uses Playwright's Chromium): `npm run store:icons`.

## Screenshots

`npm run store:shots` builds the test build and runs `store/shots/store-screenshots.spec.ts`, which
drives the **real panel and floating player** of the extension (Playwright Chromium) against the
fake MyDubb server and the synthetic lecture page, with invented sample text (an "ACID" passage
and its Vietnamese translation). No account, real course, Udemy, MyDubb, Azure, Cognito or
Supadata is contacted or shown. Each 1280×800 image is the panel's rendering (dark scheme, 420 px
wide, device scale 2) beside a short caption; Chrome's browser frame is **not** shown, because
Playwright cannot capture browser UI. The fixture lecture page is not shown either: shot 4 shows
only the floating player cut out of it.

| File | Shows |
|---|---|
| `01-send-the-transcript.png` | Not connected: **Connect to MyDubb**, **Create a MyDubb account**, email verification guidance; no guest option |
| `02-choose-language-voice-speed.png` | Pasted **English transcript**, start times, language, voice, speed, **Generate audio**, on an ordinary page |
| `03-read-and-listen.png` | **Your audio** on an ordinary page without a video: translation and independent player |
| `04-sync-with-video.png` | Sync ON (paused) and the floating player |

Checked by looking at every image (2026-11-01): text readable, nothing clipped, expected states,
no personal data. Regenerated after #45–#50 were merged (2026-11-01): the four files are
byte-identical, so they match the current UI. What differs from production: the test server
lists two languages (production eight; the voice label "Andrew Multilingual" is the same), and
there is no Azure notice (the test server runs mock providers); the captions say the Azure part
in words.

For 0.5.0 the fixture enables sign-up but disables extension guest access, matching submission
production capabilities. The first three images use an ordinary page; the fourth uses a
synthetic compatible lecture video. Account and content are invented. The test also exercises
Play/Pause and Sync before capturing. PNG output is RGB, 8 bits per channel, no alpha,
1280x800. A four-image 640x400 thumbnail contact sheet is saved in Playwright's test output.
Before upload, re-run after panel changes and inspect full images and thumbnails.

## Release ZIP

From `extension/`:

```sh
npm ci
npm run build              # dist/ (no key). Builds into dist/, not into any folder Chrome has loaded from elsewhere
npm run check:dist
npm run package:draft      # release/mydubb-extension-<version>-draft.zip  (first draft upload)
# after STABLE-ID.md step 6 (verified key recorded) and step 7 (raise the version):
npm run build:release && npm run check:dist:release && npm run package:release
```

- Only production files go in: `manifest.json` at the root, `background.js`, `content.js`,
  `offscreen.js/.html`, `sidepanel.js/.html/.css` and `icons/icon-{16,32,48,128}.png`.
  `check:dist` refuses any other file, test hook, fixture or test host; `make-zip.mjs` also refuses
  `.map`, tests, `dist-test`, `.env`, key files and documents, then reads the ZIP back and compares
  every entry with the build. `release/` is git-ignored.
- Version: `static/manifest.json`, **0.5.0** (the first draft upload was 0.4.0). Every later
  upload to the same Store item needs a higher one: raise `"version"` there **before** building the
  next package (STABLE-ID.md step 7). Node ≥ 22, `npm ci`
  from the lockfile, esbuild 0.28.2; everything is bundled, so the ZIP has no runtime dependency
  and loads no remote code.
- **Chrome's loaded folder:** this tooling writes only inside the worktree's `extension/dist`,
  `dist-release`, `dist-test` and `release`. It never touches the folder the Product Owner loads
  unpacked. To change that folder, follow STABLE-ID.md ("The unpacked build you use now").

## Not release-ready until

The policy page is deployed and its URL opens without signing in (planned
`https://mydubb.com/extension-privacy.html`; pending items are in [README.md](README.md)); the
Product Owner has decided about the reviewer test account ([LISTING.md](LISTING.md)); and the
screenshots are looked at again after any panel change. Done for the package itself: the verified
key is recorded and `npm run check:dist:release` passes.

# Images, screenshots and the release ZIP

Status (2026-11-01): **icons integrated, four screenshots made from the real one-page panel,
draft ZIP works. The package is not release-ready: the verified release key (Store Item ID and
public key) does not exist yet** ([STABLE-ID.md](STABLE-ID.md)).

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
| `01-send-the-transcript.png` | **English transcript** with the sent text, the Video row and First/Last sentence starts; connected |
| `02-choose-language-voice-speed.png` | **Translate to**: language, voice, speed, expected length, **Generate audio** |
| `03-read-and-listen.png` | **Your audio**: the loaded audio's facts, the translation before Play, the player, Sync OFF |
| `04-sync-with-video.png` | Sync ON (paused) and the floating player |

Checked by looking at every image (2026-11-01): text readable, nothing clipped, expected states,
no personal data. What differs from production: the test server's voice label ("Andrew
Multilingual") and language list, and no Azure notice (the test server runs mock providers); the
captions say the Azure part in words.

Before upload: re-run after any panel change, look at the images again, at most five files,
PNG, 1280×800.

## Release ZIP

From `extension/`:

```sh
npm ci
npm run build              # dist/ (no key). Builds into dist/, not into any folder Chrome has loaded from elsewhere
npm run check:dist
npm run package:draft      # release/mydubb-extension-<version>-draft.zip  (first draft upload)
# after STABLE-ID.md step 6 (verified key recorded):
npm run build:release && npm run check:dist:release && npm run package:release
```

- Only production files go in: `manifest.json` at the root, `background.js`, `content.js`,
  `offscreen.js/.html`, `sidepanel.js/.html/.css` and `icons/icon-{16,32,48,128}.png`.
  `check:dist` refuses any other file, test hook, fixture or test host; `make-zip.mjs` also refuses
  `.map`, tests, `dist-test`, `.env`, key files and documents, then reads the ZIP back and compares
  every entry with the build. `release/` is git-ignored.
- Version: `static/manifest.json` (0.4.0; each upload needs a higher one). Node ≥ 22, `npm ci`
  from the lockfile, esbuild 0.28.2; everything is bundled, so the ZIP has no runtime dependency
  and loads no remote code.
- **Chrome's loaded folder:** this tooling writes only inside the worktree's `extension/dist`,
  `dist-release`, `dist-test` and `release`. It never touches the folder the Product Owner loads
  unpacked. To change that folder, follow STABLE-ID.md ("The unpacked build you use now").

## Not release-ready until

The verified release key (Store Item ID and public key from a draft upload) is recorded and
`npm run check:dist:release` passes; the policy URL, support contact and publisher details are
provided; the Product Owner has decided about the reviewer test account
([LISTING.md](LISTING.md)); and the screenshots are looked at again after any panel change.

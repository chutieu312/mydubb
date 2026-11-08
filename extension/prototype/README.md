# Sync prototype: one controller for any page's HTML5 video (development only)

Prototype phase of the story "Sync with a shared HTML5 video controller". It answers, before any
integration, whether MyDubb's existing Sync can drive the `<video>` of pages other than Udemy, which
pages, and with which access. It is a **separate unpacked extension** ("MyDubb Sync prototype"):
it is never in `dist/`, never in the Chrome Web Store package, has no MyDubb account and plays a
local test MP3 (the backend's mock audio, 30.5 s). It does not touch the Generate or playback code of
the extension.

## What it reuses, unchanged

| Part | Module | Role in the prototype |
|---|---|---|
| Choosing the video | `pickVideo`, `isRenderedVideo`, `seekBounds` (`src/content/video.ts`) | Over the frame's candidates, plus two stricter rules (below) |
| Reading and Play/Pause | `AttachedVideo` (`src/content/video.ts`) | State stream, `play()` with its `NotAllowedError` mapping |
| The page's half of Sync | `VideoSync` (`src/content/sync.ts`) | attach/seek/play/pause/position/release, rate keeping, mute ownership, echoes vs user actions |
| The coordinator | `SyncController` (`src/offscreen/sync.ts`) | Runs in the lab page with the test `<audio>`; drift correction as in MyDubb |
| Mapping and texts | `syncMapping`, `videoTime`, `audioTime`, notices (`src/shared/sync.ts`) | V = V0 + A·R, the span is "where the video is, MP3 length × R" |

New, prototype-only: `src/probe.ts` (injected on the user's click; scan, binding watch, Play/Pause
checked on the element), `src/lab.ts` (the side panel: steps 1–4 and the report), `src/drift.ts`
(measurements). No site adapter: the only selector is `video`.

### Two rules added to the video choice for pages other than Udemy

Both came from the tests (fixture and real Loom):

1. **No "the only one playing" rule.** With several drawn candidates, `pickVideo` takes the only one
   playing; on other pages that is a muted autoplaying teaser. Here several drawn candidates are
   *not compatible* until the user starts one (the probe sees that `play`) or one is bound.
2. **Muted and looping = preview/background**, not a candidate unless the user started it. Muted
   autoplay alone is *not* enough: the real Loom share page starts its main video muted by itself
   (first version of the rule rejected it).

A muted video that starts with no recent input on the page is not counted as "the user's start".

## Build and try (Product Owner, real Chrome)

```sh
cd extension
npm ci
npm run build:prototype      # writes extension/dist-prototype/
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist-prototype`. It can sit
   next to the MyDubb extension (different ID; it calls no server).
2. Open the page, e.g. a Loom share page `https://www.loom.com/share/<id>`.
3. Click the toolbar button **MyDubb Sync prototype**. The click gives it access to this tab only
   (`activeTab`) and opens the lab as the tab's side panel.
4. **1. Find the video → Scan this tab.** Read the decision line. "Not compatible yet … Play the main
   video once" → start the main video yourself on the page, then Scan again. "Frames from X are not
   accessible" (e.g. Loom embedded in another site) → **Allow access to X** (Chrome asks you; it is
   an optional per-site permission), then it scans again.
5. **2. Play / Pause from MyDubb**: Play video, Pause video, ±5 s. Each line says what the element
   really did (`playing`, `still-paused`, `not-advancing`, `paused`) and the page's user activation.
6. **3. Sync**: choose a video speed R, **Turn Sync on** (the video pauses, is muted, moves), **Play**.
   Then try: −5 s/+5 s and the seek bar; the page's own seek bar, Play/Pause and speed menu; DevTools →
   Network → *Slow 4G* and a seek far ahead (buffering); another tab and back. "Drift now" and
   "Steady |d|" are the measurements.
7. **4. Report**: give the page a name, **Copy report** (or Save report) and send it. The report holds
   origins and media numbers only (no page path, title or text).
8. Lifecycle: open another video / navigate / reload: the log says "binding ended" and the audio stops.
   After a navigation, click the toolbar button again if Scan says there is no access.

## Results of the prototype phase (2026-11-08)

Evidence kinds: **fixture** = synthetic pages on a local server (`e2e/server.ts`), Playwright's
Chromium; **real page (automated)** = the real public page, the prototype's *test* build in
Playwright's Chromium, fresh profile, not signed in, host access granted by the test build (not
`activeTab`); **PO** = the Product Owner's own Chrome. Nothing is **PO** yet.

| Page | Evidence | Video found / access | Play/Pause (checked on the element) | Sync R | Steady \|d\| (max) | After seek (MyDubb / page) | Page Pause/Play | Speed | Buffering | Binding end |
|---|---|---|---|---|---|---|---|---|---|---|
| a. Fixture: one direct `<video>` | fixture | yes, top frame | pass; refused Play reported `play-blocked → still-paused` | 1.5 | 0.11 s | aligned < 0.25 s / < 0.25 s | audio follows both | page sets 2x while playing → Sync off "rate-changed", video keeps 2x and gets its sound back | seek past loaded data: video waits ~5 s, audio held, both resume aligned in 0.1–0.25 s (two runs) | — |
| a. W3C HTML5 media events page (direct `<video>`) | real page (automated) | yes, top frame | pass | 1.25 / 1.5 | 0.03 s / 0.04 s | 0.10–0.15 s / 0.02 s | page has no shortcut (not tested) | Sync off gives back 1x and sound | only short waits after seeks | reload → "binding ended" |
| a. **Loom share page** (`loom.com/share/…`, MSE `blob:`) | real page (automated) | yes, top frame (Loom autoplays it **muted**, at its own **1.2x**) | pass | 1.25 / 1.5 | 0.03–0.07 s | 0.12–0.17 s / 0.11 s | Loom's Space: audio pauses / resumes aligned in 0.23 s | Loom did not reset R while playing; Sync off → back to Loom's 1.2x, Loom's own mute kept | only short waits after seeks; slow network **not tested** | reload → "binding ended"; play outside the span → "seek-outside" |
| b. Fixture: main + second video + muted looping preview | fixture | **not compatible** until the user plays one, then yes | pass | 1 | — | — | — | — | — | SPA content switch (new path + element) → binding ended, audio stopped; query-only change → kept; same element, new source → binding ended |
| b. Fixture: main + muted looping preview / background only | fixture | main yes, preview left alone / "no video" | — | 1 | — | — | — | — | — | — |
| b. Loom community page (preview loop 5 s + hidden main video) | real page (automated) | not compatible until the user clicks the player, then yes (frame of loom.com) | pass | — | — | — | — | — | — | — |
| c. Fixture: player in a cross-origin iframe | fixture | yes, frame | pass | 1.25 | 0.12 s | — / aligned | — | player resets 1x on play → Sync sets R again, keeps playing | — | — |
| c. **Loom embed** (`loom.com/embed/…` in a local page) | real page (automated) | after the user's click: yes, frame of `www.loom.com` | pass | 1.25 | 0.05 s | 0.14 s / 0.03 s | audio pauses / resumes aligned in 0.23 s | Sync off → 1.2x and sound back | — | — |
| c. Fixture: preview in page + large frame without access | fixture | **not compatible** ("frames from … not accessible"), nothing bound | — | — | — | — | — | — | — | — |

The steady drift of ~0.1 s on the fixtures (vs ~0.01–0.05 s on W3C/Loom) is a constant offset from
the synthetic silent WAV; it stays under the 0.3 s correction threshold and no correction was made.

### Autoplay and "Play refused" (fixture, Chrome's strict policy `document-user-activation-required`)

- The page's own `play()` with sound at load: `NotAllowedError`.
- MyDubb's Play with sound, injection and command **without** any user gesture: refused,
  reported `play-blocked → still-paused`, the video stays paused.
- A click in MyDubb's own page (the lab; the side panel in MyDubb) that sends the command over the
  port **carries user activation into the page frame**, and the same is true of an injection started
  by that click: Play is then accepted. An injection by the service worker gives none.
- **Sync plays anyway without any gesture**: it mutes the video first, and Chrome lets a muted video
  play. Also in a cross-origin frame.
- Not reproduced: Chrome's default policy with its media-engagement exceptions on the PO's profile.

### Limits found

- **Access**: `activeTab` reaches the top frame of the clicked tab only. A player in a frame of another
  origin (Loom embedded in a course site) needs that origin's host permission: the prototype asks for
  it with an optional host permission (`optional_host_permissions: https://*/*, http://*/*`; nothing
  is granted at install, Chrome asks per site). Whether `activeTab` survives a reload/navigation on
  the PO's Chrome is **not verified** (Playwright cannot click the toolbar button).
- The "inaccessible frame" check compares a frame's `src` origin with the origins it could inject
  into: redirects and sandboxed (`null` origin) frames can make it report a frame that is fine
  (seen on the Loom community page: `https://loom.com` → `www.loom.com`).
- Videos inside a shadow root are counted but not searched.
- Players hidden until clicked (Loom embed/community) need the user's start + a new Scan.
- Speed menus, other players' own speed resets, DRM, live streams, picture-in-picture: not tested on
  real sites. Loom did not reset R in these runs.
- Background tab throttling: not reproducible in Playwright.
- The fixture media is audio-only WAV: Chrome does not wait for data of a **muted** audio-only element,
  so throttled-network buffering could not be shown with it; the buffering fixture stalls a seek instead.

## Proposed integration scope (for the Product Owner to decide)

1. **One generic page binding**, no site adapters: the probe's choice (pickVideo minus "only playing",
   muted+loop excluded, user start or binding decides among several, ambiguity = not compatible),
   in all frames the extension may access; `VideoSync` and `SyncController` unchanged.
2. **Sync on top-frame HTML5 video** (Loom share pages and similar): shown to work end to end on the
   real page (automated); needs the PO's acceptance in Chrome.
3. **Players in a cross-origin frame** (Loom embeds): the controller works there; it needs a per-site
   host permission request → a manifest/Store change (optional host permissions and their
   justification) to approve before it is built in.
4. Udemy keeps its own content script and lesson identity; pages without one identifiable video stay
   on "Generate / listen on its own" (Story 1).
5. Texts: the Sync notices still say "Udemy"; generic wording is needed.

## Checks

```sh
npm run test:prototype                           # 16 browser tests on the fixtures + the autoplay diagnostic
PROTO_LIVE_URLS="https://www.loom.com/share/<id>" npx playwright test -c prototype/playwright.config.ts live
PROTO_LIVE_CLICK=1 PROTO_LIVE_URLS="local:/embed-loom.html?id=<id>" npx playwright test -c prototype/playwright.config.ts live
```

`npm run test:prototype` is local (not in CI); the unit tests (`src/drift.test.ts`), lint and
typecheck of the prototype run with the extension's own `npm test`, `npm run lint`, `npm run
typecheck`. Reports of each run: `test-results/prototype-reports/*.json` (not committed). The live
probe opens real public pages and plays their video; it sends nothing.

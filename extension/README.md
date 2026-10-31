# MyDubb Chrome extension (prototype)

On a Udemy lecture: select transcript text → right-click → **Send to MyDubb** → the text appears in
a side panel. There you can edit it, control the lecture video (Play/Pause, −5 s/+5 s, time),
connect your **MyDubb invitation account**, choose the output language, voice and speed, **Generate
audio**, follow the job, read the translation and listen to the MP3 in the panel.

This is a **prototype**, installed only with Developer mode → Load unpacked; it is not on the Chrome
Web Store. Nothing is sent to MyDubb until you choose **Generate audio** (apart from loading the
public list of languages and voices, and the sign-in when you choose **Connect MyDubb**). Guests
("Try as guest") cannot use the extension.

## Build and install

Requires Node 22+ and Chrome 116+ (desktop).

```sh
cd extension
npm ci
npm run build          # writes extension/dist/, talking to https://mydubb.com
```

The MyDubb server is fixed at build time and becomes the extension's only host permission:
`MYDUBB_ORIGIN=http://localhost:8000 npm run build` for a local backend (plain http only for
`localhost`/`127.0.0.1`). The browser-test build uses `https://mydubb.test`, which never resolves.

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `extension/dist` folder. Note the extension **ID** on its card.
3. Open (or **reload**) a Udemy lecture tab (`https://www.udemy.com/course/<course>/learn/lecture/<id>`).
   Tabs that were open before the extension was installed or reloaded need a page reload.

After a rebuild, click the reload icon on the extension card, then reload the Udemy tab.

**The server must allow this extension ID** (`EXTENSION_IDS`, see
[docs/EXTENSION_AUTH.md](../docs/EXTENSION_AUTH.md)). An unpacked extension's ID depends on the
folder's path, so it differs per computer/folder, and a Web Store build would get yet another ID.

## Try it

1. On the lecture page, select some transcript text, right-click → **Send to MyDubb**.
   The side panel opens for that tab with the exact text (line breaks kept, nothing rendered as HTML).
2. Edit the text if you like. Sending a new selection over an edited draft asks first
   (**Replace draft** / **Keep my draft**). **Clear** empties the draft.
3. **Udemy video**: **Play/Pause**, **−5s**, **+5s**. The panel shows the video's real state and time.
4. **MyDubb account → Connect MyDubb**: Chrome opens a MyDubb window; sign in there with your
   invitation (email and password are typed on mydubb.com, never in the extension) and choose
   **Connect extension**. **Disconnect** ends it.
5. **Dubbing**: the two start times (type digits, the colons appear; a timestamped transcript fills
   them from its first and last caption and is dubbed in timed mode unless you tick **Ignore the
   timestamps**), **Translate to** (Vietnamese by default), **Voice** (Andrew/Emma), **Audio speed**
   (seven speeds), the expected length, then **Generate audio**.
6. **MyDubb audio**: the job's status, the choices it was made with, then the translation, durations,
   notices and a player for the MP3. Nothing plays by itself; the player is always 1x (the speed is
   already in the file) and is separate from the Udemy video controls.

The toolbar button **Open MyDubb Prototype** opens the panel for the current tab without a selection.
If the panel could not be opened from the menu, the button shows a **!** badge; click it.

Note: Play/Seek act on the real Udemy video and may update your watch progress.

## Permissions and why

| Permission | Why |
|---|---|
| `contextMenus` | The **Send to MyDubb** item, shown only for a text selection on `https://www.udemy.com/*` pages. |
| `sidePanel` | The tab-specific side panel. |
| `storage` | `chrome.storage.session` only (memory, cleared when the browser quits, readable by the extension's own pages, not by content scripts): the draft, the selection hand-over, the form settings and the job a tab follows, and the MyDubb token. |
| `identity` | `chrome.identity.launchWebAuthFlow`: the MyDubb sign-in window for **Connect MyDubb**. |
| Host `https://mydubb.com/*` (the build's `MYDUBB_ORIGIN`) | Calls to the MyDubb API from the side panel. No other host. |
| Content script on `https://www.udemy.com/*` | Reads the selection when you choose the menu item, and finds/controls the lecture `<video>` while a panel is connected. Top frame only. |

No `<all_urls>`, `tabs`, `cookies`, `history`, `webRequest`, `scripting`, `downloads`, no
`externally_connectable` and no `web_accessible_resources`. The extension does not read cookies,
does not download video, does not intercept network requests and does not use Udemy APIs.
`npm run check:dist` fails if the permissions change.

## How it works

- **Service worker** (`src/background`): creates the menu item; on click it opens the side panel
  for that tab only (`sidePanel.setOptions({tabId, path: "sidepanel.html?tabId=N"})` + `open`, in
  the user gesture), asks the content script for the selection, and stores it as a *pending
  selection* in `storage.session`. When a tab closes it removes that tab's draft, form and job. It
  keeps no state in globals and plays no part in MyDubb calls, so it can be stopped at any time.
- **Content script** (`src/content`): idle until a panel connects. While at least one panel is
  connected it watches the page (one MutationObserver, one 1 s timer, media events) and stops
  everything when the last panel disconnects. It never receives anything about MyDubb.
  - *Video choice*: only rendered `<video>` elements count. One candidate → that one. Several → the
    one you last started, the one already attached, or the only one playing; otherwise the panel
    says it cannot tell and keeps controls disabled. It never just takes the first.
  - *Lecture identity*: course slug + lecture id from the URL path. SPA navigation is detected
    (Navigation API, popstate and the timer); a new lecture or a replaced `<video>` gets a new
    controller id.
  - Commands carry the lecture key and video id the panel showed; the content script refuses any
    command for a different lecture or video (`stale`). Seeks are clamped to the seekable range.
    `muted`, `volume` and `playbackRate` are never changed.
- **Side panel** (`src/panel`): bound to one tab id. It connects a port to that tab's top-frame
  content script, reconnects after reload/navigation, and reports a closed tab. Every page state is
  checked against the lecture the draft (and any waiting selection) belongs to: when the tab shows
  another lecture, or is confirmed to be on a non-lecture page, the draft is cleared from the panel
  and from session storage, and the panel says so. Reloading or reconnecting to the same lecture
  keeps the draft.
- **MyDubb** (`src/panel/dubbing.ts`, `api.ts`, `auth.ts`, `jobs.ts`):
  - *Account*: Authorization Code + PKCE through the MyDubb website
    ([docs/EXTENSION_AUTH.md](../docs/EXTENSION_AUTH.md)). The token is in `storage.session` only
    and is sent as `Authorization: Bearer`; requests never carry cookies (`credentials: "omit"`).
  - *Form and request*: the languages, voices and default come from `GET /api/meta`; the seven
    speeds, timestamp typing, timed/plain detection, caption-filled start times, length preview and
    the request body come from the website's own modules (`frontend/src/lib/*`, imported, not
    copied), so the same input gives the same request as the Studio. Only the transcript and the
    choices are sent; no Udemy URL, title or lecture id.
  - *Generate*: one request per click, button locked until it is answered; the click's input is
    copied, so later edits do not change it. A request whose answer is lost or times out (60 s) is
    **never resent**: the panel says the outcome is unknown (a job may exist that it cannot find),
    and only a new click sends again. Before
    sending, the job is recorded for the tab (account connection, lecture, operation id), so a panel
    closed mid-request shows the same warning when reopened.
  - *Timeouts*: every request has a deadline that also covers reading the body (JSON 30 s, job
    creation 60 s, MP3 120 s); the panel's own cancellation (closing, account/lecture change) is
    told apart from a timeout and from an unreadable answer. A failed MP3 download offers
    **Check again**.
  - *Following*: the panel polls the job itself (1 s, ×1.5 up to 10 s, 30 min limit, stops after 5
    failed requests in a row, on completed/failed, `401`, a lecture or account change, or when the
    panel closes). Closing the panel never cancels or recreates the job; reopening it (same browser
    session, same account connection and lecture) resumes following it.
  - *Result*: the translation as text (right to left for Arabic), the choices and durations, the
    server's notices, and the MP3 fetched with the token as a Blob and played from an object URL
    (revoked when replaced, on account/lecture change and when the panel closes). Nothing plays by
    itself; `playbackRate` stays 1.
  - *Isolation*: every answer is checked against the account connection, lecture and click it was
    sent for, again after each storage write; a late answer for another one is dropped, never
    stops the current job's polling, and the tab's job record is written and removed one step at
    a time, each only for its own click. On opening, the stored form is read before the waiting
    selection and page state are applied, so the older snapshot never overwrites them (a manual
    change of the start times for the same draft and lecture is kept). Moving the tab to another lecture stops the
    audio and hides the result (the job keeps running on MyDubb). Disconnecting, or a refused token,
    clears the result in every panel. Each tab has its own job and player. The draft (your Udemy
    selection) is kept on an account change.
- **Validation**: every message is shape-checked; the content script accepts ports only from this
  extension's `sidepanel.html` and selection requests only from the extension itself (not from a
  tab). The manifest has no `externally_connectable`, so web pages cannot message the extension.

## Checks

```sh
npm run lint && npm run typecheck && npm test && npm run build && npm run check:dist
npx playwright install chromium   # once
npm run test:browser              # builds dist-test/ and runs Playwright
```

- `npm test`: Vitest unit tests. Story 1: video choice, controller, seek limits, play() rejection,
  message and sender validation, port lifecycle and timer cleanup, SPA lecture change, draft
  decisions, service-worker handlers. Story 2: API client (no cookies, bearer, timeout without
  retry, error shapes, audio fetch), PKCE (RFC 7636 vector), state/redirect checks, polling backoff
  and limits, job records, and the panel controller against a fake API (request body, timed/plain,
  double click, snapshot, field errors, unknown outcome, failed job, resume, lecture and account
  changes, late answers, refused token, disconnect, audio object URL, 1x and cleanup).
- `npm run check:dist`: `dist/` has no test hook or test server and exactly the documented
  permissions.
- `npm run test:browser`: the real extension in Playwright's Chromium against **synthetic fixture
  pages** served for `https://www.udemy.com/...` and a **fake MyDubb server** for
  `https://mydubb.test` (udemy.com and mydubb.com are never contacted; other requests are aborted).
  Story 1 flows, plus: connect, generate with the chosen options and listen (a real MP3 decoded, 1x,
  not autoplayed, token never in the page), panel closed/reopened and tab reload resume the job,
  stopped service worker, lost answer not resent, lecture change and second tab, disconnect and
  refused token. These are not evidence of behaviour on the real Udemy site or the real MyDubb.
- `dist-test/` is the same build plus two hooks: one in the service worker lets the tests run the
  menu handler (Playwright cannot click a native context menu), one in the panel stands in for
  Chrome's sign-in window (Playwright cannot drive it). Both are compiled out of `dist/`; CI checks
  that.

CI runs all of this in the **Chrome extension** job, part of **CI success**.

## Acceptance on the real Udemy site (Product Owner)

Needs `EXTENSION_IDS` on the server (EXTENSION_AUTH.md) and a lecture you have access to. Real jobs
use the Azure free allowance.

1. Build, Load unpacked, add the ID to `EXTENSION_IDS`, reload the Udemy lecture.
2. Send a transcript selection; Story 1 controls still work.
3. **Connect MyDubb** → sign in with an invitation account in the MyDubb window → **Connect
   extension** → the panel says "Connected as …". (If the window already knows your website
   session, it goes straight to Connect.)
4. Choose the times, language, voice, speed → **Generate audio** → statuses → translation and
   player; press play; it is at 1x and does not move the Udemy video.
5. Close and reopen the panel while a job runs; move to another lecture while one runs (no result
   there); use a second Udemy tab; **Disconnect** (all panels clear).

## Limits (prototype)

- Udemy lecture pages only; quizzes/articles show "no video". Video inside an iframe is not supported.
- When the content script cannot be reached (e.g. inside an iframe) the selection falls back to
  Chrome's `selectionText`, which may collapse whitespace.
- Invitation accounts only (no guest), no YouTube import, no automatic transcript extraction, no
  floating player, no audio/video synchronization, no MP3 download button in the panel.
- One job per tab is followed; a new Generate replaces it in the panel (the previous one keeps
  running on MyDubb, but neither the panel nor the website lists it). After a lecture change the
  panel no longer shows the earlier lecture's job. A job whose creation answer was lost cannot be
  found again (there is no job list).

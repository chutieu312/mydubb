# MyDubb Chrome extension (local prototype)

Select transcript text on a Udemy lecture → right-click → **Send to MyDubb** → the text appears in a
side panel, where you can edit it and control the lecture video (Play/Pause, −5 s/+5 s, time).

This is a **local prototype**. It does not log in to MyDubb, call any backend, translate or make
audio. Nothing is sent over the network. It is installed only with Developer mode → Load unpacked;
it is not on the Chrome Web Store.

## Build and install

Requires Node 22+ and Chrome 116+ (desktop).

```sh
cd extension
npm ci
npm run build          # writes extension/dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `extension/dist` folder.
3. Open (or **reload**) a Udemy lecture tab (`https://www.udemy.com/course/<course>/learn/lecture/<id>`).
   Tabs that were open before the extension was installed or reloaded need a page reload.

After a rebuild, click the reload icon on the extension card, then reload the Udemy tab.

## Try it

1. On the lecture page, select some transcript text, right-click → **Send to MyDubb**.
   The side panel opens for that tab with the exact text (line breaks kept, nothing rendered as HTML).
2. Edit the text if you like. Sending a new selection over an edited draft asks first
   (**Replace draft** / **Keep my draft**). **Clear** empties the draft.
3. Use **Play/Pause**, **−5s**, **+5s**. The panel shows the video's real state and time.
4. The toolbar button **Open MyDubb Prototype** opens the panel for the current tab without a selection.
   If the panel could not be opened from the menu, the button shows a **!** badge; click it.

Note: Play/Seek act on the real Udemy video and may update your watch progress.

## Permissions and why

| Permission | Why |
|---|---|
| `contextMenus` | The **Send to MyDubb** item, shown only for a text selection on `https://www.udemy.com/*` pages. |
| `sidePanel` | The tab-specific side panel. |
| `storage` | `chrome.storage.session` only: the draft and the hand-over of a selection, kept in memory, readable by the extension's own pages (not by content scripts), cleared when the tab closes or the browser quits. |
| Content script on `https://www.udemy.com/*` | Reads the selection when you choose the menu item, and finds/controls the lecture `<video>` while a panel is connected. Top frame only. |

No `<all_urls>`, `tabs`, `cookies`, `history`, `webRequest`, `scripting`, `downloads` or host
permissions. The extension does not read cookies or credentials, does not download video, does not
intercept network requests and does not use Udemy APIs.

## How it works

- **Service worker** (`src/background`): creates the menu item; on click it opens the side panel
  for that tab only (`sidePanel.setOptions({tabId, path: "sidepanel.html?tabId=N"})` + `open`, in
  the user gesture), asks the content script for the selection, and stores it as a *pending
  selection* in `storage.session`. It keeps no state in globals, so it can be stopped at any time.
- **Content script** (`src/content`): idle until a panel connects. While at least one panel is
  connected it watches the page (one MutationObserver, one 1 s timer, media events) and stops
  everything when the last panel disconnects.
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
  content script, reconnects after reload/navigation, and reports a closed tab. On a lecture change
  it clears the draft and says so.
- **Validation**: every message is shape-checked; the content script accepts ports only from this
  extension's `sidepanel.html` and selection requests only from the extension itself (not from a
  tab). The manifest has no `externally_connectable`, so web pages cannot message the extension.

## Checks

```sh
npm run lint && npm run typecheck && npm test && npm run build
npx playwright install chromium   # once
npm run test:browser              # builds dist-test/ and runs Playwright
```

- `npm test`: Vitest unit tests (video choice, controller, seek limits, play() rejection, message
  and sender validation, port lifecycle and timer cleanup, SPA lecture change, draft decisions,
  service-worker menu handler).
- `npm run test:browser`: the real extension in Playwright's Chromium against **synthetic fixture
  pages** served for `https://www.udemy.com/...` by request routing (udemy.com is never contacted;
  other network requests are aborted). Covers selection → panel, confirm/cancel replace, Clear,
  empty selection, Play/Pause/Seek and clamping, several videos, replaced video, SPA lecture change,
  reload, tab close, two tabs, unsupported tab. The fixture tests are not evidence of behaviour on
  the real Udemy site.
- `dist-test/` is the same build plus a service-worker hook that lets the tests run the menu
  handler (Playwright cannot click a native context menu). The hook is compiled out of `dist/`; CI
  checks that.

CI runs all of this in the **Chrome extension** job, part of **CI success**.

## Limits (prototype)

- Udemy lecture pages only; quizzes/articles show "no video". Video inside an iframe is not supported.
- When the content script cannot be reached (e.g. inside an iframe) the selection falls back to
  Chrome's `selectionText`, which may collapse whitespace.
- No floating player, no MyDubb login/API, no translation or audio, no automatic transcript
  extraction, no audio/video sync.

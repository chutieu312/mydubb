# MyDubb Chrome extension (prototype)

On a Udemy lecture: select transcript text → right-click → **Send to MyDubb** → the text appears in
a side panel. There you can edit it, control the lecture video (Play/Pause, −5 s/+5 s, time),
connect your **MyDubb invitation account**, choose the output language, voice and speed, **Generate
audio**, follow the job, read the translation and listen to the MP3, in the panel or in a small
**floating player** on the lecture page that keeps playing when the panel is closed. With **Sync
with video** on, the MyDubb audio and the Udemy video play, pause and seek together.

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

The panel has a short header and two tabs. The **header** shows MyDubb, the account state
(**Connect MyDubb** when not connected) and the lecture's short title (the full title on hover);
**Details** holds the full lecture title and id, the tab id, the page-link state, the account email
and **Disconnect**. A problem with the link to the tab (not a lecture, reloading, tab closed) is shown
in the header itself. **Create audio** is the form; **Listen** is the job, the result and the player.
Switching tabs only changes what is shown: the draft, a running job, the audio and Sync carry on.
Arrow keys, Home and End move between the tabs.

1. On the lecture page, select some transcript text, right-click → **Send to MyDubb**.
   The side panel opens for that tab on **Create audio** with the exact text (line breaks kept,
   nothing rendered as HTML); a selection sent while Listen is shown brings the form back.
2. Edit the text if you like. Sending a new selection over an edited draft asks first
   (**Replace draft** / **Keep my draft**). **Clear** empties the draft.
3. **Connect MyDubb** (header): Chrome opens a MyDubb window; sign in there with your invitation
   (email and password are typed on mydubb.com, never in the extension) and choose **Connect
   extension**. **Details → Disconnect** ends it.
4. **Create audio → Audio options**: the **Udemy video** box (always shown, right above the start
   times, whose position it helps to read): the video's time and state, **Play/Pause**, **−5s**,
   **+5s**. Then the two start times (type digits, the colons appear; a
   timestamped transcript fills them from its first and last caption and is dubbed in timed mode
   unless you tick **Ignore the timestamps**), **Translate to** (Vietnamese by default), **Voice**
   (Andrew/Emma), **Audio speed** (seven speeds), the expected length, the short Azure notice, then
   **Generate audio**. **About timing and length** explains the estimate. Once MyDubb accepts the
   request, the panel shows **Listen**; a refused request keeps the form with the field to fix
   focused; no answer at all is reported beside Generate (it may have been created; never resent).
5. **Listen → Latest result**: the job's status (errors with **Check again** where it helps), the
   **Use new audio** callout when relevant, and **Translation & details** (the translation, which
   can be selected and copied, the job's choices, durations and notices). The MP3 is loaded into the
   tab's player (nothing plays by itself). A job that finishes while you are on Create audio does
   not switch tabs: the Listen tab shows **New** (or **Error**). Without a job or audio, Listen
   shows a short empty state with a **Create audio** button.
6. **Listen → Loaded audio** (the player): Play/Pause, −5s/+5s, a seek bar and the time, with the
   language, voice, speed, video source span and MP3 length the file was made with. Always 1x (the
   speed is already in the file); separate from the Udemy video controls. **Show floating player**
   puts the same player on the lecture page:
   - drag it by its **MyDubb** handle (or focus the handle and use the arrow keys); it stays inside
     the window when you resize or zoom;
   - **–/+** collapses/expands it (playback goes on); **×** pauses and hides it (the job, the draft
     and the loaded audio stay; **Show floating player** in the panel brings it back);
   - close the side panel: the audio keeps playing and the floating player keeps working.

   The panel and the floating player control **one** audio: switching between them keeps the
   position and Play/Pause. Playing in another Udemy tab pauses this one (each keeps its position).
   A new **Generate audio** does not replace or stop what you are listening to: when its result is
   ready, the result shows a callout next to it ("New audio is ready. The player is still using an
   earlier result.") with the new audio's language, voice, speed, **video source** span and real MP3 length
   and a **Use new audio** button; it stops the old audio and loads the new one (paused, Sync OFF,
   no new job). The player's **Loaded audio** block shows the same facts for the audio it actually
   holds (taken from that audio's own session, never from the form), with an **Earlier result**
   badge while it differs from the new result. The video source is the job's Sync snapshot (plain: its two start times; timed: the first/last caption, milliseconds kept), never the form and never the start-time fields of a timed job (those only set the requested baseline); audio without a snapshot says "Not recorded". Sync
   applies to the loaded audio. If the switch fails, nothing claims the new audio is in use and
   **Load audio** retries without a new job.
7. **Sync with video** (panel and floating player, OFF by default): the first time it shows the
   video span V0 → V1, the MP3 length and the video speed it will use, and that the video is muted
   because the MyDubb audio replaces the spoken part (timing is an estimate); **Turn on sync**. Both
   pause, the video moves to the audio's position at that speed, muted; nothing plays until you
   press Play. Then Play/Pause/seek bar/±5 s of MyDubb drive both (the bar stays in MP3 time), and
   Play/Pause/seek on the Udemy video drive the audio. **Turn off sync** pauses both and gives the
   video its sound and speed back. It never turns itself on (Generate, reload, another lecture or
   result, account change).
8. Moving to another lecture, leaving the lecture, reloading or closing the tab, **Disconnect** or
   an account change stops the audio and removes the player. After a reload, **Load audio** in the
   panel downloads the same result again (it never creates a job).

The toolbar button **Open MyDubb Prototype** opens the panel for the current tab without a selection.
If the panel could not be opened from the menu, the button shows a **!** badge; click it.

Note: Play/Seek act on the real Udemy video and may update your watch progress. With Sync on, the
video also runs faster or slower than 1x and is moved by MyDubb's seeks, which Udemy may count as
watching (or skipping) that part of the lecture.

## Permissions and why

| Permission | Why |
|---|---|
| `contextMenus` | The **Send to MyDubb** item, shown only for a text selection on `https://www.udemy.com/*` pages. |
| `sidePanel` | The tab-specific side panel. |
| `storage` | `chrome.storage.session` only (memory, cleared when the browser quits, readable by the extension's own pages, not by content scripts): the draft, the selection hand-over, the form settings and the job a tab follows, and the MyDubb token. |
| `identity` | `chrome.identity.launchWebAuthFlow`: the MyDubb sign-in window for **Connect MyDubb**. |
| `offscreen` | One hidden extension page (`offscreen.html`) that plays the MyDubb audio, so it keeps playing when the side panel closes. Created when a result's audio is loaded; it closes itself when no tab has audio left. Reasons `AUDIO_PLAYBACK` and `BLOBS` (it holds the MP3 Blob and its object URL while paused; with `AUDIO_PLAYBACK` alone Chrome would close it after 30 s of silence). |
| Host `https://mydubb.com/*` (the build's `MYDUBB_ORIGIN`) | Calls to the MyDubb API from the side panel. No other host. |
| Content script on `https://www.udemy.com/*` | Reads the selection when you choose the menu item, finds/controls the lecture `<video>` while a panel is connected, draws the floating player (display and playback commands only), and while **Sync with video** is on mutes the video and sets its speed. Top frame only. |

No `<all_urls>`, `tabs`, `cookies`, `history`, `webRequest`, `scripting`, `downloads`, no
`externally_connectable` and no `web_accessible_resources`. The extension does not read cookies,
does not download video, does not intercept network requests and does not use Udemy APIs.
`npm run check:dist` fails if the permissions change.

## How it works

- **Service worker** (`src/background`): creates the menu item; on click it opens the side panel
  for that tab only (`sidePanel.setOptions({tabId, path: "sidepanel.html?tabId=N"})` + `open`, in
  the user gesture), asks the content script for the selection, and stores it as a *pending
  selection* in `storage.session`. When a tab closes it removes that tab's draft, form and job and
  tells the offscreen document; when the stored MyDubb connection changes it tells the offscreen
  document which connection is current. It keeps no state in globals and plays no part in MyDubb
  calls or playback, so it can be stopped at any time (its listeners wake it).
- **Content script** (`src/content`): idle until a panel connects. While at least one panel is
  connected, or a playback session is linked to the page, it watches the page (one
  MutationObserver, one 1 s timer, media events) and stops everything when neither is left. It
  never receives anything about the MyDubb account, job or audio address.
  - *Video choice*: only rendered `<video>` elements count. One candidate → that one. Several → the
    one you last started, the one already attached, or the only one playing; otherwise the panel
    says it cannot tell and keeps controls disabled. It never just takes the first.
  - *Lecture identity*: course slug + lecture id from the URL path. SPA navigation is detected
    (Navigation API, popstate and the timer); a new lecture or a replaced `<video>` gets a new
    controller id.
  - Commands carry the lecture key and video id the panel showed; the content script refuses any
    command for a different lecture or video (`stale`). Seeks are clamped to the seekable range.
    `muted`, `volume` and `playbackRate` are never changed, except `muted` and `playbackRate` while
    Sync with video is on (below); `volume` never.
- **Side panel** (`src/panel`): bound to one tab id. It connects a port to that tab's top-frame
  content script, reconnects after reload/navigation, and reports a closed tab. Every page state is
  checked against the lecture the draft (and any waiting selection) belongs to: when the tab shows
  another lecture, or is confirmed to be on a non-lecture page, the draft is cleared from the panel
  and from session storage, and the panel says so. Reloading or reconnecting to the same lecture
  keeps the draft. The two tabs (`src/panel/tabs.ts`) only hide and show markup (`hidden`, so the
  inactive panel is out of the tab order); the panel controller tells them when a request was
  accepted (Listen), refused (Create, focus on the field) or a followed job was restored on opening
  (Listen, unless the user already picked a tab), and a selection from the page shows Create.
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
    server's notices, and the MP3 fetched with the token as a Blob and handed to the tab's playback
    session (below). Nothing plays by itself; `playbackRate` stays 1. Reopening the panel while the
    session still has this job's audio attaches to it instead of downloading again.
  - *Isolation*: every answer is checked against the account connection, lecture and click it was
    sent for, again after each storage write; a late answer for another one is dropped, never
    stops the current job's polling, and the tab's job record is written and removed one step at
    a time, each only for its own click. On opening, the stored form is read before the waiting
    selection and page state are applied, so the older snapshot never overwrites them (a manual
    change of the start times for the same draft and lecture is kept). Moving the tab to another lecture stops the
    audio and hides the result (the job keeps running on MyDubb). Disconnecting, or a refused token,
    clears the result in every panel. Each tab has its own job and player. The draft (your Udemy
    selection) is kept on an account change.
- **Playback** (`src/offscreen`, `src/panel/player.ts`, `src/content/playback.ts`, `floating.ts`):
  - *Owner*: the offscreen document holds at most one session per tab: its own `<audio>` element
    and object URL, tied to the tab, lecture, account connection, job and Generate click. The panel
    and the floating player are remote controls of that session, so there is never a second MyDubb
    audio for a tab, and `playbackRate` is held at 1.
  - *Audio hand-over*: the panel downloads the MP3 with the token (same request, deadline and
    cancellation as before), then offers the Blob on an extension-origin `BroadcastChannel`, only
    for a transfer the offscreen document asked for on the panel's port. The offscreen document
    never sees the token; no base64/data URL, nothing in `chrome.storage` or chrome messaging.
  - *Ports*: the panel connects a runtime port bound to its own `?tabId` (checked against the
    sender URL); the content script connects one whose tab Chrome sets (`sender.tab`, top frame,
    `https://www.udemy.com`), so a page can only reach its own tab's session. The page gets display
    state only (time, duration, Play/Pause, the file's language/voice/speed labels, floating
    visible); commands carry the session id and lecture and are refused when either is stale.
  - *Lifecycle*: after a session is opened the panel asks its content script (over its tab port) to
    link; only then may the session play (otherwise nobody would notice a lecture change). The
    content script keeps watching the lecture while linked, also with the panel closed; another
    lecture or none ends the session, and so does the page port going away (reload, navigation,
    closed tab), a closed tab reported by the worker, or the end of the account connection (the
    worker forwards `storage.onChanged`; an ended connection can open nothing again). A new
    Generate keeps the current session until **Use new audio**. Ending stops the audio, revokes
    the object URL and removes the listeners; with no session left the document closes itself.
    Playing a tab pauses every other tab's session.
  - *Floating UI*: a `mydubb-player` element with a closed Shadow DOM (styles isolated, placement
    pinned with inline `!important`), built with `textContent` only; only trusted events act, so a
    page script can neither click it nor reach the extension (`window.postMessage` is not used).
    Labelled buttons, a labelled range input with a value text, keyboard-movable handle.
- **Sync with video** (`src/shared/sync.ts`, `src/offscreen/sync.ts`, `src/content/sync.ts`):
  - *Mapping*: the MP3 already has the speed in it, so the audio plays at 1x and is the clock. With
    V0/V1 the start and end of the source span on the video, D the real MP3 duration (the audio
    element's) and A the MP3 position: `R = (V1 − V0) / D`, `V = V0 + A × R`, `A = (V − V0) / R`.
    Example: V0 10 s, V1 30 s, D 13.333 s → the video runs at 1.5x and A = 4 s is V = 16 s.
  - *The span is the job's own*: copied at the Generate click into the tab's job record (never read
    from the form later). Plain: the two start times sent. Timed: the first and last caption
    (milliseconds kept) with the baseline of the two fields; if you changed the fields, the MP3 is
    `baseline / speed` long and R differs from the speed you chose. V1 is the start of the last
    sentence/caption, as in the job contract; no tail is added. The span is kept only if the result
    agrees (baseline, speed, and the caption span the server reports for timed jobs). Sync is
    **unavailable** (the audio still plays on its own) for a job without a span (older records),
    an MP3 that does not fit `baseline / speed` (more than 0.25 s or 1 % off, e.g. mock audio), or
    an R outside Chrome's 0.0625–16. The page checks that V0..V1 lies inside the video's seekable
    range and reads the rate back after setting it; anything refused stops Sync with a message,
    nothing is clamped.
  - *Coordinator*: the offscreen document (it owns the audio and outlives the panel). The content
    script binds the video it identified and runs a few operations on it (`attach`, `seek`, `play`,
    `pause`, `position`, `release`), reporting what the video does that MyDubb did not ask for.
    Numbers only on the page port: no token, job, account or audio address.
  - *No event loops*: every activation has a `syncId`, every operation a command id; replies for
    another activation or an abandoned command are dropped, and each new user action supersedes
    older async steps. Both sides keep what the media is *wanted* to do (paused/playing, MyDubb's
    last operation or the user's last reported action), plus the pending seek target and the rate
    set: an event that agrees with it, or that the element's state has already overtaken (a late
    "pause" of something playing again), is no news; anything else is the user's or the site's.
    This holds whatever the order and timing of media events, across turning Sync off and on
    (`event.isTrusted` is not relied on). A seek on the video moves only the
    audio, so it never comes back as another video seek.
  - *Controls*: Play aligns the video to the audio, starts it, then starts the audio where the video
    is. A seek on the video inside V0..V1 moves the audio; outside it pauses both and turns Sync off
    (the video is not pulled back). Reaching V1 or the end of the MP3 pauses both; Play then starts
    both from the beginning. An unmute is respected (shown, never muted again).
  - *The video's rate*: some players put their own speed back on the element by themselves around
    a start, pause or seek (the fixture's "site" player does; whether the real Udemy player does is
    not verified). A rate other than R within 2 s after attach, a MyDubb operation or a play,
    pause, seek or "playing" of the video, with no pointerdown/keydown on the page since then, is
    the page's: R is set again, at most 3 times per 10 s; if it still does not hold, both pause and
    Sync turns off with "the video speed did not stay at R" (no tug of war, no timer). Any other
    rate change (while it plays steadily, or after the user's click or key: picking a speed) pauses
    both and turns Sync off, saying the speed changed from R, without claiming who changed it; it
    is not forced back. Only the time of the last input is kept. The MP3's rate, the job's span and
    speed are never touched to work around it.
  - *Diagnostics*: the coordinator keeps a trace of the last 60 steps (op, reply and event names,
    command ids, the action generation, the activation id's first 8 characters, the expected R and
    the video's actual `playbackRate`, times) and logs each with `console.debug("MyDubb sync", …)`
    in the offscreen document (chrome://extensions → MyDubb → Inspect views: offscreen.html,
    console level Verbose). No token, transcript, account, job or lecture URL is in it.
  - *Buffering and errors*: intent (paused/playing) is kept apart from buffering. While one side
    waits for data the other is held; only an intent to play still in force resumes it (a Pause
    during buffering stays paused). A play refused by Chrome or a failing side pauses the other and
    says so. Operations time out (attach 5 s, seek/play 10 s, position 3 s); a late answer changes
    nothing.
  - *Drift*: `d = (V − V0) / R − A` in MP3 seconds, V read by the page when it answers, A when the
    answer arrives. Checked once per second only while both play (no timer otherwise, never per
    frame). |d| ≤ 0.3 s is left alone (seeking the video is a visible jump and may rebuffer, and
    the timing itself is an estimate to a few tenths); a larger d seen twice in a row is corrected
    by seeking the video, never by changing the audio's rate, at most once per 3 s and 3 times per
    30 s; the next one pauses both ("kept drifting apart"). A background tab is not counted against
    that limit (Chrome may throttle it), and coming back to the tab realigns at once; a video the
    browser paused in a background tab is restarted aligned on return.
  - *Ownership*: at attach the page notes the element's `muted` and `playbackRate`; it mutes only an
    unmuted video, never touches `volume`, and on release gives back only what still holds MyDubb's
    value, only on the same element still showing the same media (not on a reused element showing
    another lecture). Turning Sync off, closing the floating player (×) and another tab starting
    MyDubb audio pause the video too. *One audio*: every start of a session's audio (MyDubb's
    Play, Play on the synced video, a resume after buffering, Chrome's media controls) first pauses
    every other tab's session and its synced video, each keeping its position; a late event of an
    audio paused since then takes nothing back. A replaced video element ends Sync (the new one is never
    driven by an old command; turn it on again). A lecture change, reload, closed tab, Disconnect,
    account change or another result ends the session and with it Sync.
- **Validation**: every message is shape-checked; the content script accepts ports only from this
  extension's `sidepanel.html` and selection requests only from the extension itself (not from a
  tab); the offscreen document checks the sender of every port and message as above. The manifest
  has no `externally_connectable`, so web pages cannot message the extension.

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
  changes, late answers, refused token, disconnect, 1x and cleanup). Two tabs (`panel/tabs.test.ts`
  and the panel controller): ARIA roles, roving tab index, arrow/Home/End keys, focus moved to the
  shown tab instead of lost, Generate accepted → Listen (and not before), a validation error back to
  Create with the field focused, a refusal without a field, unknown outcome kept beside Generate,
  a finished or failed job never switching tabs (New/Error on the Listen tab instead), switching
  tabs sending nothing and keeping draft, job, playback and Sync, the empty state, reopened panel
  on Listen when a job is followed, the account change shown on Listen. Story 3: the offscreen
  sessions (`offscreen/hub.test.ts`: Blob only for an announced transfer and only audio, senders of
  panel/page/worker, play only when linked, seek limits, 1x, autoplay blocked and failed start,
  media error, one tab at a time, Close, lecture change, page gone, closed tab, ended connection,
  replacement releasing the old audio, document closing), the message contracts, the panel link
  (handshake, no document created to look, retry), the floating UI (trusted events only, text only,
  seek, collapse/close, viewport clamp), the content-script link and lecture watch with the panel
  closed, and the panel's player (choices from the job, keep-until-switch, reopened panel does not
  download again, sessions of another connection ended, Load audio after a release). Story 4: the
  mapping (`shared/sync.test.ts`: V0 with milliseconds, all seven speeds, timed with and without
  changed start times, refusals), the panel's span (plain/timed, kept from the click, dropped when
  the result disagrees, older records without it, the explanation and toggle), the coordinator
  (`offscreen/sync.test.ts`: on/off, Play/Pause/seek both ways, outside the span, end and restart,
  echoes and late answers, buffering on each side, Pause during buffering, blocked play, timeouts,
  small and large drift, limited corrections, background tab), the page side (`content/sync.test.ts`:
  ownership of mute and rate, user unmute and rate change, reused element, replaced element,
  echoes vs user actions, end of span, a page resetting the rate on play/playing/seek, a tug of war
  (bounded), the restore limit per window, a speed picked right after Play, late rate events across
  off/on) and the hub (two tabs, Close, ending sessions).
- `npm run check:dist`: `dist/` has no test hook or test server and exactly the documented
  permissions.
- `npm run test:browser`: the real extension in Playwright's Chromium against **synthetic fixture
  pages** served for `https://www.udemy.com/...` and a **fake MyDubb server** for
  `https://mydubb.test` (udemy.com and mydubb.com are never contacted; other requests are aborted).
  Story 1 flows, plus: connect, generate with the chosen options and listen (a real MP3 decoded, 1x,
  not autoplayed, token never in the page), panel closed/reopened and tab reload resume the job,
  stopped service worker, lost answer not resent, lecture change and second tab, disconnect and
  refused token. Story 3 (`e2e/floating.spec.ts`, a real 30 s MP3 decoded in the offscreen
  document): floating player shown on request, played from the page with the panel closed, no
  token/audio address/`<audio>` on the page, video untouched; handoff keeping position and
  Play/Pause with one audio; collapse, drag by the handle only, keyboard move, viewport clamp on
  resize, Close and reopen; ±5 s and seek limits at 1x; SPA lecture change with the panel closed,
  reload (no replay, Load audio without a job), tab close and the document closing itself; two tabs
  (B pauses A); disconnect from another tab's panel; stopped service worker (and one woken by a
  disconnect); expired result and retries without a job; synthetic clicks ignored; a paused session
  surviving 36 s (past Chrome's 30 s silent-audio limit). Story 4 (`e2e/sync.spec.ts`, the real
  MP3 in the offscreen document and a real 60 s WAV played by the fixture's `<video>`): Sync off by
  default, the explanation, on/off restoring mute and rate, Play/Pause/±5 s from the panel, drift
  measured over 24 s of playback at R ≈ 1.5 (both by the test and by the coordinator), play, pause
  and seek on the video inside and outside the span, a timed job with changed start times
  (R ≈ 0.98 at 1.5x), an MP3 that does not fit, the floating player with the panel closed, a
  speed picked in the page's player, a page that puts 1x back on play (Sync sets R again and both
  play) or on every rate change (bounded, then both pause with the reason), an unmute, the end of the span and Play again, Close, two tabs, a replaced
  video, a stopped service worker, Disconnect, reload and an SPA lecture change. Two tabs
  (`e2e/tabs.spec.ts`, at 360 px, a real side panel's width, and 320 px): keyboard use and the tab
  order, the empty state, a validation error (field focused), Generate → Listen, editing the form
  while the job finishes (no switch, **New** badge), the translation selectable, tab switches during
  playback (still playing, no request), no sideways scroll on either tab, and a reopened panel on
  Listen attached to the same session (no download, no job). Autoplay is allowed
  by a browser flag in these tests, so Chrome's autoplay blocking is only unit-tested, and
  background-tab throttling is not reproduced (unit-tested only). These are not evidence of
  behaviour on the real Udemy site or the real MyDubb.
- `dist-test/` is the same build plus test hooks: one in the service worker lets the tests run the
  menu handler (Playwright cannot click a native context menu), one in the panel stands in for
  Chrome's sign-in window (Playwright cannot drive it), an inspection message in the offscreen
  document reports what its media elements are doing, and the floating player's shadow root is
  open (closed in `dist/`) so Playwright can reach its controls. All are compiled out of `dist/`;
  CI checks that.

CI runs all of this in the **Chrome extension** job, part of **CI success**.

## Acceptance on the real Udemy site (Product Owner)

Needs `EXTENSION_IDS` on the server (EXTENSION_AUTH.md) and a lecture you have access to. Real jobs
use the Azure free allowance.

1. Build, Load unpacked, add the ID to `EXTENSION_IDS`, reload the Udemy lecture. Updating from an
   earlier build: `npm run build`, then the reload icon on the extension card (Chrome asks for no
   new permission prompt for `offscreen`), then reload every open Udemy tab. The extension ID does
   not change as long as the folder stays the same.
2. Send a transcript selection; Story 1 controls still work.
3. **Connect MyDubb** → sign in with an invitation account in the MyDubb window → **Connect
   extension** → the panel says "Connected as …". (If the window already knows your website
   session, it goes straight to Connect.)
4. Choose the times, language, voice, speed → **Generate audio** → the panel shows **Listen** →
   statuses → player (translation under **Translation & details**); press play; it is at 1x and
   does not move the Udemy video. While a job runs, go back to **Create audio** and edit: when it
   finishes you stay there and the Listen tab says **New**. Check that the panel is readable at
   its default width and when made narrower (no sideways scroll).
5. Close and reopen the panel while a job runs; move to another lecture while one runs (no result
   there); use a second Udemy tab; **Disconnect** (all panels clear).
6. Floating player: with a result loaded, play a little in the panel, **Show floating player**
   (same position, same Play/Pause), close the side panel and keep listening; drag it, collapse it,
   resize the window; check it does not hide the Udemy controls you need (drag it away if it does);
   **×** pauses it, the panel shows it again. Play in a second lecture tab (the first pauses). Then
   move to another lecture, reload, and **Disconnect** with the panel closed: each stops the audio
   and removes the player.
7. Sync with video (Play and seeks move the real lecture video, run it faster or slower than 1x
   and may change your watch progress; use a lecture where that does not matter). Generate with the
   two start times of the selected transcript (and the speed you want), then **Sync with video**:
   check that V0 → V1 and the speed match the transcript, **Turn on sync**: the video moves to V0
   (or the audio's position), muted, paused. Play from the panel and from the floating player
   (panel closed): voice and picture stay together within the stated estimate for the whole span;
   Pause, ±5 s and the seek bar move both. On the Udemy player: Play/Pause and seeking inside the
   span move the audio; seeking before V0 or after V1 turns Sync off with both paused. Change the
   speed in the Udemy player: Sync turns off, both paused. With the video at 1x before turning
   Sync on, Play must run it at R without touching the Udemy speed menu; if Sync still turns off,
   copy the "MyDubb sync" lines from the offscreen console (above): they show which step the rate
   changed after and to what. Unmute the video: it stays unmuted.
   Let it reach the end: both pause; Play starts again from V0. Switch to another tab for a while
   and come back: the video catches up. Turn Sync off: the video's sound and speed are back.
   Also: × on the floating player, playing another lecture tab, moving to another lecture,
   reload and **Disconnect** while synced (each pauses or ends both, and the video gets its sound
   and speed back). Note anything Udemy's player does that the fixture does not (its own seeks on
   load, speed menu, buffering).

## Limits (prototype)

- Udemy lecture pages only; quizzes/articles show "no video". Video inside an iframe is not supported.
- When the content script cannot be reached (e.g. inside an iframe) the selection falls back to
  Chrome's `selectionText`, which may collapse whitespace.
- Invitation accounts only (no guest), no YouTube import, no automatic transcript extraction, no
  playback speed control (the speed is chosen at Generate), no MP3 download button.
- Sync with video follows the job's span as a whole: plain mode maps the whole MP3 linearly onto
  V0..V1, timed mode has the known grouping and alignment limits of timed dubbing; neither is word
  or sentence exact. Drift is kept within about 0.3 s in the local tests, which is no promise for a
  throttled background tab or for Udemy's own player (not checked on udemy.com). The video runs at
  R, which may differ from the chosen speed (changed start times). Only one Udemy video that the
  content script identifies; a job without a confirmed span, or an MP3 not fitted to its times,
  cannot be synced (Generate it again). The end of the span is detected on `timeupdate` (about 4
  per second), so the muted video may run up to about 0.25 s × R past V1 before it pauses.
- The audio continues only once it has been loaded in the player; a panel closed before the result
  arrives stops following the job (reopen it to continue). A reload, lecture change or tab close
  ends the player; reopening it downloads the result again while MyDubb still has it (1 hour).
- The player keeps one MP3 per tab in memory until that tab's player ends. A token revoked on the
  server is noticed at the panel's next MyDubb request, not instantly: audio already loaded can
  play on until then (Disconnect in the extension stops it at once).
- The floating player's default place is the top right of the window; on the real Udemy layout it
  may cover something and has to be dragged away (not checked on udemy.com).
- One job per tab is followed; a new Generate replaces it in the panel (the previous one keeps
  running on MyDubb, but neither the panel nor the website lists it). After a lecture change the
  panel no longer shows the earlier lecture's job. A job whose creation answer was lost cannot be
  found again (there is no job list).

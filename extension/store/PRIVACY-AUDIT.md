# Data audit, permission justifications and dashboard answers (DRAFT)

Status: **draft, not confirmed by the Product Owner, nothing declared on the dashboard.** Prepared
2026-10-31 and re-checked against the merged one-page panel on 2026-11-01: code at `origin/main`
`b2a7a40` (PR #45; extension 0.4.0), manifest and the backend documents named in each row. Server
features that are **not merged** (the open PR for usage/cost records) are not described;
**re-audit §2 if it merges**, because it may change what the server records. The admin role (PR #47)
is merged and listed in §2; it does not touch the extension.

"Verified" below means read in code or in this repository's documents. Anything about what a
third party (Microsoft, Render, Neon, AWS) keeps or does is **not verified here**.

No transcript, token, e-mail address or other user data is quoted in this document.

## 1. What the extension handles

| Data | Read when / by | Sent to | Stored where, how long | Removed by |
|---|---|---|---|---|
| **Selected transcript text** (user-selected on a `https://www.udemy.com/*` lecture page; editable in the panel) | On the **Send to MyDubb** menu click, by the content script (falls back to Chrome's `selectionText`) | **Extension only** until the user clicks **Generate audio**; then the MyDubb server (`POST /api/jobs`, field `transcript`). Never to the Udemy page | Extension: `chrome.storage.session` (browser memory, access level `TRUSTED_CONTEXTS`, not readable by content scripts) as the tab's draft. Server: see §2 | **Clear** (the draft and the pending selection only; not the form, the job, the loaded translation or the audio), closing the tab, browser quit (session storage), uninstalling |
| **Start times, language, voice, speed, timing mode** (form values) | Form in the panel | MyDubb server on Generate (same request) | Extension: `storage.session` (`form:<tab>`), saved as they change. Server: job metadata, §2 | Closing the tab (all `tabKeys`), browser quit, uninstalling. Moving to another lecture blanks the stored start times (language, voice and speed stay). **Not** removed by Clear, Disconnect or an account change (they hold choices, not account data) |
| **Udemy page facts**: lecture URL path (course slug, lecture id), page title (first 300 chars), the lecture `<video>`'s time, duration, paused, rate, muted, seekable range | By the content script while a panel is connected or an audio session is linked; stops when neither is left | **Not sent to MyDubb** (the job request has no URL, title or lecture id; checked in `frontend/src/lib/jobRequest.ts`). The panel and the floating player get them through the extension's own ports | Extension only: the lecture key is kept with the draft/job record in `storage.session`; the title is shown in the panel | Changing lecture clears the draft; closing the tab; browser quit |
| **Control of the lecture video**: pause and seek to the start of the passage when a new audio is loaded (no Sync needed); Play/Pause/±5 s from the panel; with **Sync with video** on (user's choice) also mute and speed | The content script sets the video's `paused`, `currentTime` and, with Sync, `muted` and `playbackRate`; reads position | Nothing leaves the browser | n/a (Sync restores mute and speed when it turns off) | Turn Sync off |
| **Translation of the loaded audio** (text derived from the user's transcript) | Received from the server when a job completes (`GET …/result`) | n/a (received) | Extension: `chrome.storage.session` (`loaded:<tab>`), so the panel shows it after reopening; stored with the user id, connection id and lecture key it belongs to; the audio's own copy lives in the player session | A newer result replaces it once its audio has loaded (a refused or failed Generate, or a failed download, keeps it). Each of these removes it whether or not a job record is left: moving to another lecture or off the lecture pages, Disconnect, an ended or expired connection, another account (unit tests: refused Generate, then Disconnect, account or lecture change; a pending write of the old copy cannot bring it back). Closing the tab (all `tabKeys`) and browser quit remove it too. A reopened panel keeps it only for the same account, connection and lecture and removes any other copy. **Not** removed by Clear or by a page reload (the audio ends on reload; the translation stays for **Load audio**) |
| **MyDubb account connection**: token, user id, e-mail, display name, expiry | After **Connect MyDubb**: the sign-in happens on `https://mydubb.com` in Chrome's sign-in window (`chrome.identity.launchWebAuthFlow`); the extension never sees the password or the website cookie | The token goes to the MyDubb server as `Authorization: Bearer` on `/api/jobs*`, `/api/extension/*` (`credentials: "omit"`) | Extension: `storage.session`. Server: `user_sessions` row (SHA-256 of the token, `client='extension'`), life at most 12 h (`EXTENSION_SESSION_TTL_SECONDS`) | **Disconnect** (clears storage, then ends the token on the server); password reset or administrator revocation end it on the server; browser quit clears the extension copy |
| **Generated MP3** | Downloaded by the panel with the token | n/a (received) | Extension: memory only (a Blob in the offscreen document, one per tab), never written to storage | Ended (audio stopped, object URL revoked) by: a newer result, which replaces it by itself once its own MP3 has downloaded (the earlier audio stays usable meanwhile; a refused or failed Generate or a failed download keeps it); lecture change, reload, tab close, Disconnect, another account |
| **Public configuration** (`GET /api/meta`: languages, voices) | On panel open, no token | MyDubb server | Not stored by the extension | n/a |
| **Ordinary request data** (IP address, `Origin`, time) | Inherent in every request to the MyDubb server | MyDubb server and its host | The server's access log prints the client address (documented in `docs/GUEST_ACCESS.md`); how long Render keeps logs is **not verified** | Not controlled by the extension |

### Requests to MyDubb that happen without a click on Generate or Connect

Read from `extension/src/panel/dubbing.ts` (`loadRemote`, `restore`, `follow`, `loadAudio`) after PR #45. None
carries transcript text; all reach the server with the network address (and, where noted, the
token). The policy and the listing must not say that nothing is sent before Generate/Connect.

| Trigger | Request | Carries |
|---|---|---|
| Side panel opens | `GET /api/meta` | Nothing but the request itself (no token) |
| Side panel opens with a stored token | `GET /api/extension/session` | Token |
| Panel opens, or stays open, with a job recorded for this tab and lecture (state "created") | `GET /api/jobs/{id}`, polling until the job ends, an error, a change of lecture or account, or the panel closes (up to 30 minutes) | Token, job id |
| The followed job completes | `GET /api/jobs/{id}/result` (translation) and `GET …/result/audio` (MP3); the new audio then replaces the loaded one by itself | Token, job id |
| Panel closed while a job runs, opened again later in the same tab, lecture and account | The status polling above; the result and audio are fetched when it completes (so the new audio can be loaded only at that moment) | Token, job id |
| Panel reopened on audio that is already loaded | None (position, playback and Sync are left alone) | – |
| **Check again** / **Load audio** buttons (Load audio after a reload or a failed download) | The same job and result requests; no new job | Token, job id |

Not automatic: creating a job (`POST /api/jobs`, only on **Generate audio**), sign-in
(`/api/extension/token`, only after **Connect MyDubb**) and `POST /api/extension/logout` (only on
**Disconnect**).

The content script also listens for pointer and key events on the Udemy page, **only to know
whether the user touched the page** (it decides whether a changed video speed is the user's); it
records and sends nothing about them.

## 2. What the MyDubb server does with a Generate request

| Step | Verified fact (source) |
|---|---|
| Transcript text | Held in worker memory until the job finishes; not written to the database (`docs/ARCHITECTURE.md` "Data retention") |
| Sent to Microsoft Azure | **Yes.** The transcript text goes to **Azure Translator**; the translated text goes to **Azure Speech** to make the voice. The panel says "Your text is processed by Microsoft Azure". What Microsoft keeps, and for how long, is governed by Microsoft's terms and is **not verified here** |
| Translation text and MP3 | Local disk of the server, deleted `RESULT_TTL_SECONDS` after completion (**default 1 hour**; the value set on production was not re-checked for this audit); expired results are refused (`410 result_expired`) |
| Job metadata (status, voice, target language, timestamps, baseline duration, speed, character count, provider names, error, owning user id) | PostgreSQL (Neon, AWS us-west-2 per `docs/DEPLOYMENT.md`). **No automatic deletion today.** A 7-day retention is only a proposal, not implemented (`docs/context.md` §6) |
| English terms found in the translation ("glossary candidates": term, kind, counts, first/last seen) | PostgreSQL, **no automatic deletion**; no transcript, translation, job or user is stored with a term (`docs/ARCHITECTURE.md`). They are derived from user text |
| Account | Invitation accounts only, e-mail/password via Amazon Cognito behind MyDubb's own sign-in; the `users` table keeps issuer, `sub`, e-mail, display name, disabled flag and, since migration 0012 (PR #47, merged), a `role` (`user` or `admin`, set only by an operator tool; no API and no extension action writes it); no password; no automatic deletion. `user_role_events` records each role change (user id, old/new role, time, operator login name) without an e-mail and outlives the account |
| Logs | Application logs hold counts, status codes and ids, never transcript text or translations (`docs/ARCHITECTURE.md`); the uvicorn access log has client addresses (above) |
| Deletion on request | **No self-service way and no documented process to delete job metadata or an account.** Do not promise one in the policy until the Product Owner decides how it is handled |
| Encryption at rest | **Not verified** (Neon, Render disk). In transit: the extension talks to one `https` origin; plain `http` is accepted only for a `localhost` build |

## 3. Outside the extension (do not mix into the extension's disclosures)

The MyDubb website: the Studio form, "Try as guest", **YouTube caption import** (Supadata), website
sign-in and its session cookie. None of it is in the extension: guests cannot connect it and the
extension has no YouTube import. The policy draft is scoped to the extension and the service
requests it makes, and points to a separate website policy; a website appendix (guest session,
cookies, hashed network quota, YouTube/Supadata) is written in
[PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) for the case that the Product Owner wants one
policy for both. The scope is the Product Owner's decision.

## 4. Permission and host justifications (text for the dashboard)

| Item | Needed for | Justification text |
|---|---|---|
| `contextMenus` | **Send to MyDubb** | Adds one right-click item, shown only when text is selected on a Udemy page, to send that selection to the side panel. |
| `sidePanel` | The panel | Shows the transcript, the dubbing controls and the player in Chrome's side panel for the current tab. |
| `storage` | Draft, job, connection | Used only as `chrome.storage.session` (memory, cleared when the browser quits): the selected text, form choices, the job being followed, the translation of the loaded audio and the MyDubb sign-in token. |
| `identity` | **Connect MyDubb** | `chrome.identity.launchWebAuthFlow` opens the MyDubb sign-in window so the password is typed on mydubb.com, never in the extension. |
| `offscreen` | Audio keeps playing when the panel closes | One hidden extension page plays the generated audio (reasons AUDIO_PLAYBACK and BLOBS), so playback continues if the side panel is closed. |
| Host `https://mydubb.com/*` | Every MyDubb call | Sends the user's own request (text and choices) to the MyDubb service and receives the translation and audio. No other host. |
| Content script `https://www.udemy.com/*` (top frame) | Selection, video controls, floating player, Sync | Reads the selected text when the user chooses the menu item, finds the lecture video to play, pause and seek it (it is paused and moved to the start of your passage when new audio loads) and (only if the user turns on Sync) mute and change the speed of that video, and draws the small floating audio player on the page. |
| Remote code | n/a | **No.** All code is in the package; the extension makes no `eval`, no remotely hosted script. |

No `<all_urls>`, `tabs`, `cookies`, `history`, `webRequest`, `scripting`, `downloads`,
`externally_connectable` or `web_accessible_resources`. `npm run check:dist` enforces this list.

## 5. Single purpose (draft)

> Turn the English transcript text a user selects on an Udemy lecture page into audio in another
> language with the user's own MyDubb account, and play it next to the lecture video.

## 6. Privacy practices tab: what the facts require (pending confirmation on the dashboard)

**These are not choices.** The declaration must match what the extension and server really do;
the Product Owner confirms the facts (§1, §2) and then makes the declaration. Chrome's pages say
"handle" means "collecting, transmitting, using, or sharing user data", that it applies "even when
data is processed or stored locally on a user's device", and that dashboard disclosures must stay
consistent with the privacy policy and the real behaviour (Chrome Web Store User Data FAQ).

**Pending confirmation:** the exact names, definitions and certification wording of the
dashboard's checkboxes were **not readable** in Chrome's public pages (they list nine examples of
user data, not the dashboard's own labels). Before declaring, open the live Privacy practices tab
and compare each definition below with the facts. Until then every row is "pending".

| Fact in this extension (§1) | Chrome's wording it must be compared with | Handled how | Status |
|---|---|---|---|
| E-mail and display name of the connected account | "Personally identifiable information" (name, e-mail, any ID number) | Stored in the extension; held by the server | Matches on its face: pending dashboard confirmation |
| MyDubb bearer token | "Authentication information" (logins, passwords, authentication cookies) | Stored in the extension, sent to the server | Matches on its face: pending |
| Selected transcript text (and the user's edits of it), and the translation received for it | "Website content and resources"; also possibly "User-generated content" | Text read from the Udemy page, stored in the session, sent to the server and to Azure on Generate; the translation is stored in the session too | Matches on its face: pending |
| Lecture URL path (course slug, lecture id) and page title | "Web browsing activity": "information about the websites or other web resources a user requests or interacts with" | Read by the extension, kept in the browser, **not** sent to MyDubb | Meets the definition as written, and Chrome counts local handling: pending dashboard confirmation of how local-only data is declared |
| Video state (time, duration, paused, speed, muted) of the lecture | Possibly "Website content and resources" | Read and written locally, not sent | Pending |
| Pointer and key events on Udemy pages (a flag only: "the user touched the page"; no key, position or content recorded) | Possibly the dashboard's "User activity" | Read, used in memory, discarded, not stored or sent | Pending: confirm whether transient local use counts |
| Network address of every request (server access log) | Possibly the dashboard's "Location" or "PII", if its definition includes the IP address | Received and logged by the server | Pending: check the dashboard definition |
| Health, financial/payment, personal communications | No such data is read | – | Expected not applicable; confirm |
| Remote code | None (all code is in the package) | – | Expected "No" |
| Single purpose, permission justifications | §5, §4 | – | Text ready; PO confirms |
| Certifications (the dashboard's statements on not selling data, not using it outside the single purpose, not using it for creditworthiness) | Wording pending | – | Facts in §2 and the policy must be confirmed true by the PO before certifying |
| Privacy policy URL | Required when data is handled | – | **Pending PO**: not published; scope decision in [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) |
| Limited Use statement | Must be on a site of the extension or one click from its homepage | – | Sentence is in the policy draft; PO publishes |

**Do not answer "no data collected".** The extension transmits the selected text and the token to
the MyDubb service, and a policy is required whenever user data is handled.

## 7. What the Product Owner must confirm or provide

- Operator of MyDubb for the policy and the dashboard (an individual or an organisation): name,
  and whether the dashboard publisher is trader or non-trader.
- Support e-mail (verified by the dashboard) and a **contact for privacy questions**.
- Where the policy is published (URL), its scope (extension only, or website too) and the
  homepage/support URL for the listing.
- That the facts in §1 and §2 are true for production: result lifetime (code default 1 hour),
  no analytics, which website features are on (guest, YouTube import).
- How a user asks for data to be deleted and what the operator will actually do (§2: no process
  exists today). Whether to build the proposed 7-day job-metadata cleanup first. The policy must
  say only what exists.
- Confirmation of the Microsoft Azure data handling the operator relies on (not verified here).
- After reading the live dashboard labels: the final declarations, made on the facts above.

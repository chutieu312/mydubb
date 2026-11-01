# Data audit, permission justifications and dashboard answers (DRAFT)

Status: **draft prepared 2026-10-31, not confirmed by the Product Owner, nothing declared on the
dashboard.** Based on the code at `origin/main` `cb71cd2` (extension 0.3.0) and the backend
documents named in each row. The side panel of PR #45 is not part of this audit's facts: it only
moves the same controls around; **re-check the permission and data rows after #45 merges**
(see [README.md](README.md)).

"Verified" below means read in code or in this repository's documents. Anything about what a
third party (Microsoft, Render, Neon, AWS) keeps or does is **not verified here**.

No transcript, token, e-mail address or other user data is quoted in this document.

## 1. What the extension handles

| Data | Read when / by | Sent to | Stored where, how long | Removed by |
|---|---|---|---|---|
| **Selected transcript text** (user-selected on a `https://www.udemy.com/*` lecture page; editable in the panel) | On the **Send to MyDubb** menu click, by the content script (falls back to Chrome's `selectionText`) | **Extension only** until the user clicks **Generate audio**; then the MyDubb server (`POST /api/jobs`, field `transcript`). Never to the Udemy page | Extension: `chrome.storage.session` (browser memory, access level `TRUSTED_CONTEXTS`, not readable by content scripts) as the tab's draft. Server: see §2 | Clear button, closing the tab, browser quit (session storage), uninstalling |
| **Start times, language, voice, speed, timing mode** (form values) | Form in the panel | MyDubb server on Generate (same request) | Extension: `storage.session`. Server: job metadata, §2 | Same as above |
| **Udemy page facts**: lecture URL path (course slug, lecture id), page title (first 300 chars), the lecture `<video>`'s time, duration, paused, rate, muted, seekable range | By the content script while a panel is connected or an audio session is linked; stops when neither is left | **Not sent to MyDubb** (the job request has no URL, title or lecture id; checked in `frontend/src/lib/jobRequest.ts`). The panel and the floating player get them through the extension's own ports | Extension only: the lecture key is kept with the draft/job record in `storage.session`; the title is shown in the panel | Changing lecture clears the draft; closing the tab; browser quit |
| **Video control by Sync with video** (only when the user turns it on) | Content script sets the lecture video's muted state and speed; reads position | Nothing leaves the browser | n/a (restored when Sync turns off) | Turn Sync off |
| **MyDubb account connection**: token, user id, e-mail, display name, expiry | After **Connect MyDubb**: the sign-in happens on `https://mydubb.com` in Chrome's sign-in window (`chrome.identity.launchWebAuthFlow`); the extension never sees the password or the website cookie | The token goes to the MyDubb server as `Authorization: Bearer` on `/api/jobs*`, `/api/extension/*` (`credentials: "omit"`) | Extension: `storage.session`. Server: `user_sessions` row (SHA-256 of the token, `client='extension'`), life at most 12 h (`EXTENSION_SESSION_TTL_SECONDS`) | **Disconnect** (clears storage, then ends the token on the server); password reset or administrator revocation end it on the server; browser quit clears the extension copy |
| **Generated MP3** | Downloaded by the panel with the token | n/a (received) | Extension: memory only (a Blob in the offscreen document, one per tab), never written to storage | Lecture change, reload, tab close, Disconnect, new result chosen |
| **Public configuration** (`GET /api/meta`: languages, voices) | On panel open, no token | MyDubb server | Not stored by the extension | n/a |
| **Ordinary request data** (IP address, `Origin`, time) | Inherent in every request to the MyDubb server | MyDubb server and its host | The server's access log prints the client address (documented in `docs/GUEST_ACCESS.md`); how long Render keeps logs is **not verified** | Not controlled by the extension |

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
| Account | Invitation accounts only, e-mail/password via Amazon Cognito behind MyDubb's own sign-in; the `users` table keeps issuer, `sub`, e-mail, display name, disabled flag (no password); no automatic deletion |
| Logs | Application logs hold counts, status codes and ids, never transcript text or translations (`docs/ARCHITECTURE.md`); the uvicorn access log has client addresses (above) |
| Deletion on request | **No self-service way and no documented process to delete job metadata or an account.** Do not promise one in the policy until the Product Owner decides how it is handled |
| Encryption at rest | **Not verified** (Neon, Render disk). In transit: the extension talks to one `https` origin; plain `http` is accepted only for a `localhost` build |

## 3. Outside the extension (do not mix into the extension's disclosures)

The MyDubb website: the Studio form, "Try as guest", **YouTube caption import** (Supadata), website
sign-in and its session cookie. None of it is in the extension: guests cannot connect it and the
extension has no YouTube import. The privacy policy covers the website too, so its text must stay
accurate for both; this draft only describes the website where the extension depends on it.

## 4. Permission and host justifications (text for the dashboard)

| Item | Needed for | Justification text |
|---|---|---|
| `contextMenus` | **Send to MyDubb** | Adds one right-click item, shown only when text is selected on a Udemy page, to send that selection to the side panel. |
| `sidePanel` | The panel | Shows the transcript, the dubbing controls and the player in Chrome's side panel for the current tab. |
| `storage` | Draft, job, connection | Used only as `chrome.storage.session` (memory, cleared when the browser quits): the selected text, form choices, the job being followed and the MyDubb sign-in token. |
| `identity` | **Connect MyDubb** | `chrome.identity.launchWebAuthFlow` opens the MyDubb sign-in window so the password is typed on mydubb.com, never in the extension. |
| `offscreen` | Audio keeps playing when the panel closes | One hidden extension page plays the generated audio (reasons AUDIO_PLAYBACK and BLOBS), so playback continues if the side panel is closed. |
| Host `https://mydubb.com/*` | Every MyDubb call | Sends the user's own request (text and choices) to the MyDubb service and receives the translation and audio. No other host. |
| Content script `https://www.udemy.com/*` (top frame) | Selection, video controls, floating player, Sync | Reads the selected text when the user chooses the menu item, finds the lecture video to play, pause, seek and (only if the user turns on Sync) mute and change the speed of that video, and draws the small floating audio player on the page. |
| Remote code | n/a | **No.** All code is in the package; the extension makes no `eval`, no remotely hosted script. |

No `<all_urls>`, `tabs`, `cookies`, `history`, `webRequest`, `scripting`, `downloads`,
`externally_connectable` or `web_accessible_resources`. `npm run check:dist` enforces this list.

## 5. Single purpose (draft)

> Turn the English transcript text a user selects on an Udemy lecture page into audio in another
> language with the user's own MyDubb account, and play it next to the lecture video.

## 6. Privacy practices tab: expected answers

The dashboard's own labels and certification wording **were not available to read** (Chrome's
public pages do not list them); confirm each line on the live dashboard before answering. The
data categories below are the ones in Chrome's "user data" FAQ.

| Dashboard item | Expected answer | Reason |
|---|---|---|
| Single purpose | §5 | |
| Permission justifications | §4 | |
| Remote code | No | §4 |
| Personally identifiable information | **Check** | E-mail and display name of the connected account are stored in the extension and held by the server |
| Authentication information | **Check** | The bearer token |
| Website content and resources | **Check** | The selected Udemy transcript text is read, stored in the session and sent to the server |
| Web browsing activity | **Product Owner to decide; leaning Check.** The lecture URL path and page title are read and kept in the browser only. Chrome's FAQ counts local handling as "handle"; ticking it costs nothing if the policy says "stays in your browser" |
| Health, financial/payment, personal communications, location, form data, user activity (clicks/keystrokes) | Do not check | Not read. (Page events only gate a local decision; nothing is recorded) |
| Certifications (not sold; not used outside the single purpose; not used for creditworthiness) | Certify only after the Product Owner has read §2 and the policy | Wording to be read on the dashboard |
| Privacy policy URL | **Needs the Product Owner's published URL** | Not published |
| Limited Use statement | Put this sentence in the published policy: "The use of information received by the MyDubb extension adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements." | Chrome requires the statement on a website of the extension (or one click from its homepage) |

**Do not answer "no data collected".** The extension transmits the selected text and the account
token to the MyDubb service, and a policy is required whenever user data is handled (Chrome's
Privacy Policies and User Data FAQ pages).

## 7. What the Product Owner must provide

- Operator of MyDubb for the policy and the dashboard (an individual or an organisation): name,
  and whether the dashboard publisher is trader or non-trader.
- Support e-mail (verified by the dashboard) and a **contact for privacy questions**.
- Where the policy is published (URL) and the homepage/support URL for the listing.
- How a user asks for data to be deleted, and what the operator will actually do (§2 says no
  process exists today); whether to implement the proposed 7-day job-metadata cleanup first.
- Whether the production result lifetime is still the 1 hour default.
- Whether to tick "Web browsing activity" (§6).
- Confirmation of the Microsoft Azure data handling the operator relies on (not verified here).

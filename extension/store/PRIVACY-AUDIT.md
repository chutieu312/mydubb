# Data audit, permission justifications and dashboard answers (DRAFT)

Status: **draft, not confirmed by the Product Owner, nothing declared on the dashboard.** Prepared
2026-10-31 and re-checked against the merged one-page panel on 2026-11-01: code at `origin/main`
`86c6ca4` (PR #45 panel; PR #47 admin role; PR #48 usage and reference-cost records, merged after
the first audit and now covered in §2; PR #50 spinner, which only changes how a working job's
status looks), extension 0.4.0, manifest and the backend documents named in each row. The admin
role and the usage records do not touch the extension.

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
| Sent to Microsoft Azure | **Yes.** The transcript text goes to **Azure Translator**; the translated text goes to **Azure Speech** to make the voice. The panel says "Your text is processed by Microsoft Azure". The backend calls text translation (`POST …/translate`, v3.0) and real-time text to speech (`…tts.speech.microsoft.com/cognitiveservices/v1`), not document translation or batch synthesis. Microsoft's pages for exactly those services state that they do not store the text or the generated audio (quotes and sources in §8). What Microsoft does beyond that (location, abuse monitoring) is not stated there and is **not verified here**; MyDubb's own Azure resource settings could not be read |
| Translation text and MP3 | Local disk of the server, deleted `RESULT_TTL_SECONDS` after completion (**3,600 s on production**, reported by the public `GET /api/meta` on 2026-11-01; code default also 1 hour); expired results are refused (`410 result_expired`) |
| Job metadata (status, voice, target language, timestamps, baseline duration, speed, character count, provider names, error, owning user id) | PostgreSQL (Neon, AWS us-west-2 per `docs/DEPLOYMENT.md`). **No automatic deletion today.** A 7-day retention is only a proposal, not implemented (`docs/context.md` §6) |
| Usage record per job (PR #48; `docs/USAGE_COSTS.md`, migration 0020): the client (`web` or `extension`), the kind of access, language, voice, speed, timing mode, provider names, durations, **number of characters** sent, number of blocks, MP3 size, outcome and error code, and one row per request sent to a provider (service, outcome, HTTP status, items, timing, characters sent) | PostgreSQL tables `job_usage`, `job_usage_attempts`. **Not stored there:** transcript, translation, SSML, keys, tokens, addresses, URLs, user or session ids, e-mail. No foreign key to `jobs`: the rows outlive the job row and are **not removed when the job or the user row is**. **Linkability (checked in the schema and the code, not only the foreign key):** `job_usage` has the same `job_id` as the `jobs` row, and `jobs.user_id` names the owning account, so anyone who can read the database can join the two; the join stops when the account is deleted (`user_id` becomes NULL) but the usage row then still holds the time, client, access kind, language, voice, speed, character count and outcome of that job, which can also be matched to the same fields of the surviving `jobs` row. No user, session or network identifier is written into `job_usage*` (`backend/app/usage/models.py`; the context passed in is only the fixed labels `client` and `access`, `jobs/router.py`). The `client` label tells whether the job came from the extension (`principal.bearer`). Recording can be switched off by the `USAGE_RECORDING_ENABLED` setting (default on; production value could not be read). **Deleted automatically** after `USAGE_RETENTION_DAYS` (code default **180**, range 7-3650) by the server's clean-up; production value not checked |
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

- **Confirmed by the Product Owner (2026-11-01):** the operator is Can Nguyen; support and
  privacy contact is support@mydubb.com; the policy is separate for the extension and the
  requests it sends to MyDubb (the website gets its own).
- Still open: whether the dashboard publisher is trader or non-trader; that the Chrome Web Store
  account can verify support@mydubb.com as its contact e-mail (the dashboard verifies it; this
  work cannot).
- Where the policy is published (URL), the URL of the website policy it points to, and the
  homepage/support URL for the listing.
- That the facts in §1 and §2 are true for production: result lifetime (code default 1 hour),
  no analytics, which website features are on (guest, YouTube import).
- What the operator will actually do with a deletion request and within what time (§2: no process
  exists today). Users are told only to write to support@mydubb.com; a proposed intake process is
  in [DATA-REQUESTS.md](DATA-REQUESTS.md). Whether to build the proposed 7-day job-metadata
  cleanup first. The policy must say only what exists.
- Whether the operator relies on the Microsoft statements in §8, and the regions and settings of
  MyDubb's own Azure resources (not readable from here).
- After reading the live dashboard labels: the final declarations, made on the facts above.

## 8. Read-only verification, 2026-11-01

Method: one public `GET https://mydubb.com/api/meta` (no account, no job), read-only calls to
GitHub (workflow runs and variable names), and Microsoft's public pages. Nothing was created,
changed or deployed. **No Render, Neon, Azure or hosting-log access exists in this environment**
(no Render API key or CLI, no Neon or Azure access; `RENDER_API_KEY` is a GitHub secret that
cannot be read), so those items are listed as not read, not guessed.

**Read and confirmed**

| Fact | Source |
|---|---|
| Production runs Azure providers with FFmpeg (`provider_mode` azure, `mock_mode` false, translation azure, speech azure, audio ffmpeg) | `/api/meta` |
| Eight output languages: Vietnamese, Chinese Mandarin (Simplified), Hindi, Spanish (Spain), Arabic (Modern Standard), French (France), Russian, Japanese. Two voices: Andrew Multilingual, Emma Multilingual | `/api/meta` |
| Results live `result_ttl_seconds` = **3600** | `/api/meta` |
| Sign-up is off (`self_registration` false), password reset on, auth mode Cognito | `/api/meta` |
| Guest access **enabled** (5 jobs/session, 20/network per 86,400 s, 1,000 words, 600 s, session 86,400 s, 5 imports/session, 20/network) and YouTube import **enabled** (Supadata): website features are live | `/api/meta` |
| `/api/meta` returns **no** usage-retention, usage-recording or log setting | `/api/meta` |
| The commit that added the usage records (`0c7a0b0`, #48) and the one after the benchmark (`86c6ca4`) were deployed: "Deploy to Render" and "Production smoke check" succeeded | GitHub Actions runs 41347929701 and 41353266464. This shows the deploy job ended well, not what Render runs; Render itself was not read |
| mydubb.com is served by Render behind a Cloudflare edge (headers `x-render-origin-server: Render`, `server: cloudflare`). The edge location (LAX) says nothing about where the application or database runs | Response headers |
| The Store screenshots are byte-identical after regenerating from the merged code (#45–#50); the voice label "Andrew Multilingual" is the production label. The test server lists two languages, production eight | `npm run store:shots`, compared by hash |
| The extension code changed by #48–#50 (spinner: `dubbing.ts`, `jobs.ts`, `sidepanel.css`) adds no request, storage key, permission or host. #48 adds nothing the extension sends or reads | `git diff` of `extension/` |

**Microsoft, from the official pages (read 2026-11-01; the pages show no visible date; their
metadata gives `ms.date` 2026-04-01 and 2026-02-25)**

- Translator, [Data, privacy, and security for Azure Translator in Foundry Tools](https://learn.microsoft.com/en-us/legal/cognitive-services/translator/data-privacy-security):
  "Translator doesn’t persist customer data submitted for translation:"; "Text translation
  processes customer data at REST and doesn’t store customer data." (Document translation, which
  MyDubb does not use, "temporarily stores customer data while processing".)
- Text to speech, [Data, privacy, and security for text to speech](https://learn.microsoft.com/en-us/legal/cognitive-services/speech-service/text-to-speech/data-privacy-security):
  "Microsoft doesn't retain or store the text that you provide with the real-time synthesis text
  to speech API."; "Microsoft doesn't store audio or video content generated with the real-time
  synthesis API." (Long Audio and batch synthesis, which MyDubb does not use, store scripts and
  output.)
- **Not stated on either page:** where the processing takes place, whether human review or abuse
  monitoring applies to prebuilt real-time input, and any opt-out. The policy may therefore use
  only the quotes above, attributed to Microsoft, and must not add promises about those points.
  The statements describe Microsoft's services in general, not the settings of MyDubb's Azure
  resources.

**Not read (blocked: no access)**

| Item | Where it would be read |
|---|---|
| `USAGE_RETENTION_DAYS` and `USAGE_RECORDING_ENABLED` on production | Render service environment |
| `RESULT_TTL_SECONDS` as an environment value (the effective value is confirmed above) | Render service environment |
| Render service region (`render.yaml` says `oregon`) and Neon region (`docs/DEPLOYMENT.md` says AWS us-west-2) | Render and Neon dashboards |
| `AZURE_TRANSLATOR_REGION`, `AZURE_SPEECH_REGION`, the resources' network and data settings | Render environment, Azure portal |
| Access-log retention of the host | Render dashboard and plan documentation |
| Whether the production database has the usage tables (migration 0020) | Database or Render deploy logs |
| Whether the website sets other cookies or loads analytics | Looking at the live site in a browser (not done; `/api/meta` cannot show it) |

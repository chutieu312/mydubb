# Chrome Web Store preparation for MyDubb

**Status: preparation only. Nothing is submitted, reviewed or published; nothing is declared on
any dashboard; no developer account, Item ID or verified release key exists.** The package is a
**draft, not release-ready**. This folder is not part of the extension package (`dist/` is built
from `src/`, `static/` and the icon PNGs only).

Built on the merged one-page panel (PR #45): *English transcript*, *Translate to*, *Your audio*.
A new result loads by itself; there is no "Use new audio" step and no tabs.

## State of each item (the words are not interchangeable)

| Item | Done | Needs the Product Owner | Needs the dashboard | Submitted for review | Published |
|---|---|---|---|---|---|
| Icon and logo (SVG, PNG 16/32/48/128, preview), in the manifest | yes, [branding/](branding/) | review of the look | – | no | no |
| Manifest name/description (no "Prototype"), `icons`, toolbar icon, version 0.4.0 | yes | – | – | no | no |
| `check:dist` release mode, release build, ZIP maker, tests | yes ([STABLE-ID.md](STABLE-ID.md)) | – | – | no | no |
| Stable ID: account, draft upload, Item ID, public key, `release-key.json` | **no** | account, fee, send Item ID and key | upload draft, read Item ID and key | no | no |
| Four 1280×800 screenshots from the real panel | yes, [screenshots/](screenshots/) | look at them | upload | no | no |
| Listing text, getting started, limits, support text | draft, [LISTING.md](LISTING.md) | approve wording, URLs, visibility, reviewer account | enter | no | no |
| Data audit, permission justifications, what to declare | draft, [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | confirm facts and declarations | confirm labels and enter | no | no |
| Privacy policy for the extension (the website appendix is source material for a separate policy) | draft with `[PO]` gaps, [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md); operator (Can Nguyen) and contact (support@mydubb.com) filled in | the remaining decisions below, deletion handling, publish it | enter the URL | no | no |
| Release ZIP | draft ZIP only ([RELEASE-PACKAGE.md](RELEASE-PACKAGE.md)); release ZIP waits for the key | – | upload | no | no |
| Promo tiles (optional) | no | – | upload | no | no |

## Files

| File | What |
|---|---|
| [LISTING.md](LISTING.md) | Name, short and detailed description, getting started, limits, support, reviewer notes |
| [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | What data is read, sent, stored and removed; automatic requests; permission justifications; what the Privacy practices tab must declare (pending dashboard confirmation) |
| [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | Policy text with `[PO: …]` gaps |
| [DATA-REQUESTS.md](DATA-REQUESTS.md) | **Proposal** for handling data requests sent to support@mydubb.com; where the server keeps user data; nothing in it is promised in the policy |
| [STABLE-ID.md](STABLE-ID.md) | Account → draft upload → Item ID/public key → verified key → release build and check; effect on `EXTENSION_IDS` and sessions |
| [RELEASE-PACKAGE.md](RELEASE-PACKAGE.md) | Chrome's image sizes, screenshots, how to rebuild the ZIP |
| `branding/` | `mydubb-icon.svg`, `mydubb-icon-small.svg`, `png/`, `preview.png` |
| `screenshots/` | The four Store screenshots |
| `shots/` | The Playwright spec that makes them |
| `tools/` | `render-icons`, `render-preview`, `key-to-id`, `zip`, `make-zip`, and `release.test.mjs` |

## What the Product Owner still has to provide or do

1. ~~Operator, support e-mail, privacy contact, policy scope~~ **Confirmed (2026-11-01):** Can
   Nguyen; support@mydubb.com for support and privacy; a separate policy for the extension and
   the requests it sends to MyDubb.
2. Decide where the policy and a support/home page are published, whether the website gets its
   own policy (and its URL), and what is promised about deleting data (none is implemented
   today; proposal in [DATA-REQUESTS.md](DATA-REQUESTS.md)). Confirm the production facts the
   audit lists (§7). The full list of remaining placeholders is below.
3. Look at `branding/preview.png` and `screenshots/`.
4. Register the Chrome Web Store developer account (fee, verified e-mail) when ready. Then:
   `cd extension && npm ci && npm run build && npm run package:draft`, upload
   `release/mydubb-extension-0.4.0-draft.zip` in the dashboard as a **draft** (do not submit),
   and send the Item ID and the public key from the Package tab (STABLE-ID.md steps 3–6). The version is raised before the **next** upload (step 7), not for this first draft.
5. Add the Item ID to `EXTENSION_IDS` on Render when ready (not done by this work).
6. Choose the visibility (unlisted/private/public), and whether reviewers get a disposable
   invitation account and an accessible lecture.
7. Read the live Privacy practices tab, confirm the declarations, publish the policy, then enter
   the dashboard declarations and press *Submit for review* only when satisfied.

## Placeholders still in the drafts (2026-11-01)

Filled from the Product Owner: operator Can Nguyen, contact support@mydubb.com, extension-only
policy. Everything below is still a `[PO: …]` marker or a pending item. None is filled with a guess.

**A. Can be checked by a read-only look (not done yet; the answer is a fact, not a decision)**

| Marker | Where to look |
|---|---|
| Result lifetime on production (policy "What MyDubb does with your text"; code default 1 hour) | `result_ttl_seconds` in the public `GET /api/meta`, or the Render environment page |
| Usage-record retention on production (policy, same section; code default 180 days, PR #48) | `USAGE_RETENTION_DAYS` in the Render environment page |
| Eight output languages and both voices on production (listing, screenshots note) | `GET /api/meta` |
| Render region and Neon region (policy "Who receives data") | `render.yaml` says `oregon`; `docs/DEPLOYMENT.md` says Neon AWS us-west-2; confirm in the two dashboards |
| Azure settings the operator relies on (policy, Microsoft line) | Azure portal and the Render environment (`AZURE_*_REGION`); the Microsoft terms link is a public page |
| How long the host keeps access logs (policy, "Ordinary server logs") | Render's documentation and plan |
| No analytics or telemetry in the extension (policy) | Searched `extension/src` and `extension/static` on 2026-11-01: none found. Re-check before publishing; production and the website were not examined |
| Which website features are on, and the website's cookies (Appendix A only, for the website policy) | Render environment (`GUEST_ACCESS_ENABLED` defaults to `false`), a look at the live site; Supadata's terms are a public page |
| Dashboard labels on the Privacy practices tab | Readable only after a developer account exists |

**B. Needs the Product Owner's decision**

| Marker | Decision |
|---|---|
| Date of publication; changes ("how changes will be announced") | When, and how |
| Postal or contact address (optional) | Give one or not |
| Policy URL; website policy URL (Scope sentence); homepage and support URL | Where they will be published; whether to write the website policy (Appendix A is its start) |
| Trader or non-trader on the dashboard | Declare |
| Deletion handling and any time limit; sentence on job records that are not deleted automatically | Adopt, change or reject [DATA-REQUESTS.md](DATA-REQUESTS.md); whether to build the 7-day cleanup first |
| "Does not sell data / no other purpose" and "People working on MyDubb do not read your text except…" | Confirm that these are true and list the cases |
| How a user asks for an invitation | Whether it is support@mydubb.com |
| Visibility; reviewer test account and lecture | Choose |
| Developer account, fee, Item ID, public key, `EXTENSION_IDS` | As in the steps above |

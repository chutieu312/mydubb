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
| Privacy policy (extension scope + optional website appendix) | draft with `[PO]` gaps, [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | scope, operator, contact, retention and deletion decisions, publish it | enter the URL | no | no |
| Release ZIP | draft ZIP only ([RELEASE-PACKAGE.md](RELEASE-PACKAGE.md)); release ZIP waits for the key | – | upload | no | no |
| Promo tiles (optional) | no | – | upload | no | no |

## Files

| File | What |
|---|---|
| [LISTING.md](LISTING.md) | Name, short and detailed description, getting started, limits, support, reviewer notes |
| [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | What data is read, sent, stored and removed; automatic requests; permission justifications; what the Privacy practices tab must declare (pending dashboard confirmation) |
| [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | Policy text with `[PO: …]` gaps |
| [STABLE-ID.md](STABLE-ID.md) | Account → draft upload → Item ID/public key → verified key → release build and check; effect on `EXTENSION_IDS` and sessions |
| [RELEASE-PACKAGE.md](RELEASE-PACKAGE.md) | Chrome's image sizes, screenshots, how to rebuild the ZIP |
| `branding/` | `mydubb-icon.svg`, `mydubb-icon-small.svg`, `png/`, `preview.png` |
| `screenshots/` | The four Store screenshots |
| `shots/` | The Playwright spec that makes them |
| `tools/` | `render-icons`, `render-preview`, `key-to-id`, `zip`, `make-zip`, and `release.test.mjs` |

## What the Product Owner still has to provide or do

1. Decide who operates MyDubb (individual or organisation) and give the name, the support e-mail
   and a privacy contact.
2. Decide the policy scope (extension only, or website too), where it and a support/home page are
   published, and what is promised about deleting data (none is implemented today; see
   PRIVACY-AUDIT §2). Confirm the production facts the audit lists (§7).
3. Look at `branding/preview.png` and `screenshots/`.
4. Register the Chrome Web Store developer account (fee, verified e-mail) when ready. Then:
   `cd extension && npm ci && npm run build && npm run package:draft`, upload
   `release/mydubb-extension-0.4.0-draft.zip` in the dashboard as a **draft** (do not submit),
   and send the Item ID and the public key from the Package tab (STABLE-ID.md steps 3–6).
5. Add the Item ID to `EXTENSION_IDS` on Render when ready (not done by this work).
6. Choose the visibility (unlisted/private/public), and whether reviewers get a disposable
   invitation account and an accessible lecture.
7. Read the live Privacy practices tab, confirm the declarations, publish the policy, then enter
   the dashboard declarations and press *Submit for review* only when satisfied.

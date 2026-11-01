# Chrome Web Store preparation for MyDubb

**Status: preparation only. Nothing is submitted, reviewed or published; nothing is declared on
any dashboard; no developer account, Item ID or release key exists.** This folder is not part of
the extension package (`dist/` is built from `src/` and `static/` only).

This is a draft pull request. It was prepared while PR #45 (the side-panel redesign) is still
being built, so it deliberately **does not touch the panel, floating player, CSS, logic or tests**
of that work, and the final screenshots and manifest/build integration wait for #45.

## State of each item (the words are not interchangeable)

| Item | Prepared | Needs the Product Owner | Needs the dashboard | Submitted for review | Published |
|---|---|---|---|---|---|
| Icon and logo (SVG + PNG 16/32/48/128, preview) | yes, [branding/](branding/) | review of the look | – | no | no |
| Listing text, getting started, limits, support text | draft, [LISTING.md](LISTING.md) | approve wording, URLs, visibility, reviewer account | enter | no | no |
| Data audit, permission justifications, dashboard answers | draft, [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | confirm facts and answers | enter | no | no |
| Privacy policy | draft, [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | operator, contact, retention and deletion decisions, publish it | enter the URL | no | no |
| Stable ID procedure | written, [STABLE-ID.md](STABLE-ID.md); `key-to-id` helper tested | account, fee, draft upload, public key, `EXTENSION_IDS` | upload draft, read Item ID and key | no | no |
| Release ZIP | script works on today's build, [RELEASE-PACKAGE.md](RELEASE-PACKAGE.md); ZIP is **not release-ready** | – | upload | no | no |
| Screenshots (1280×800), promo tiles | plan only | permitted fixture content | upload | no | no |
| Manifest name, icons, key, `check:dist` release mode | **no** (after #45) | – | – | no | no |
| `docs/context.md` update (drop the two-tab wording) | **no** (after #45, which edits the same file) | – | – | no | no |

## Files

| File | What |
|---|---|
| [LISTING.md](LISTING.md) | Name, short and detailed description, getting started, limits, support, reviewer notes |
| [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | What data is read, sent, stored and removed; permission justifications; expected Privacy practices answers |
| [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | Policy text with `[PO: …]` gaps |
| [STABLE-ID.md](STABLE-ID.md) | Account → draft upload → Item ID/public key → build → ID check; effect on `EXTENSION_IDS` and sessions |
| [RELEASE-PACKAGE.md](RELEASE-PACKAGE.md) | Chrome's image sizes, screenshot plan and checklist, how to rebuild the ZIP |
| `branding/` | `mydubb-icon.svg`, `mydubb-icon-small.svg`, `png/`, `preview.png` |
| `tools/` | `render-icons.mjs`, `render-preview.mjs`, `key-to-id.mjs`, `make-zip.mjs` |

## What the Product Owner still has to provide or do

1. Decide who operates MyDubb (individual or organisation) and give the name, the support e-mail
   and a privacy contact.
2. Decide where the privacy policy and a support/home page are published, and what is promised
   about deleting data (none is implemented today; see PRIVACY-AUDIT §2).
3. Review the icon in `branding/preview.png`.
4. Register the Chrome Web Store developer account (fee, verified e-mail) when ready, then upload
   the draft ZIP **without submitting it**, and send the Item ID and the public key from the
   Package tab (STABLE-ID.md).
5. Add the Item ID to `EXTENSION_IDS` on Render when ready (not done by this work).
6. Choose the visibility (unlisted/private/public), and whether reviewers get a disposable
   invitation account and an accessible lecture.
7. Merge PR #45; then the follow-up integrates icons and manifest, builds the release ZIP and
   captures the real screenshots.
8. Enter the dashboard declarations and press *Submit for review* only when satisfied.

# Chrome Web Store preparation for MyDubb

**Status: preparation only. Nothing is submitted, reviewed or published; nothing is declared on
any dashboard.** The Store Item ID and public key are known and verified, and a release ZIP of 0.4.1
was built and checked locally; it has not been uploaded. This folder is not part of the extension
package (`dist/` is built from `src/`, `static/` and the icon PNGs only).

Built on the merged one-page panel (PR #45): *English transcript*, *Translate to*, *Your audio*.
A new result loads by itself; there is no "Use new audio" step and no tabs.

## State of each item (the words are not interchangeable)

| Item | Done | Needs the Product Owner | Needs the dashboard | Submitted for review | Published |
|---|---|---|---|---|---|
| Icon and logo (SVG, PNG 16/32/48/128, preview), in the manifest | yes, [branding/](branding/) | review of the look | – | no | no |
| Manifest name/description (no "Prototype"), `icons`, toolbar icon, version 0.4.1 | yes | – | – | no | no |
| `check:dist` release mode, release build, ZIP maker, tests | yes ([STABLE-ID.md](STABLE-ID.md)) | – | – | no | no |
| Stable ID: Item ID, public key, `release-key.json` | yes, verified with `key-to-id` | – | – | no | no |
| Four 1280×800 screenshots from the real panel | yes, [screenshots/](screenshots/) | look at them | upload | no | no |
| Listing text, getting started, limits, support text | draft, [LISTING.md](LISTING.md) | approve wording, homepage/support URL, visibility, reviewer account | enter | no | no |
| Data audit, permission justifications, what to declare | draft, [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | confirm declarations | confirm labels and enter | no | no |
| Privacy policy for the extension | text ready for review, no markers: [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) and the page `frontend/public/extension-privacy.html` | read and approve | enter the URL once it is live | no | no |
| Policy page at `https://mydubb.com/extension-privacy.html` | built and checked locally; **not deployed, the URL does not work yet** | decide when to merge and deploy | – | no | no |
| Release ZIP | 0.4.1 built and checked locally ([RELEASE-PACKAGE.md](RELEASE-PACKAGE.md)) | – | upload | no | no |
| Promo tiles (optional) | no | – | upload | no | no |

## Files

| File | What |
|---|---|
| [LISTING.md](LISTING.md) | Name, short and detailed description, getting started, limits, support, reviewer notes |
| [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) | What data is read, sent, stored and removed; automatic requests; permission justifications; what the Privacy practices tab must declare (pending dashboard confirmation); sources and levels of evidence (§8) |
| [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | The policy's source text. The published form is `frontend/public/extension-privacy.html`, with the same words; change both together |
| [WEBSITE-POLICY-NOTES.md](WEBSITE-POLICY-NOTES.md) | Internal notes for a possible website policy. Not a policy, not for publishing |
| [DATA-REQUESTS.md](DATA-REQUESTS.md) | What the policy says about data requests, **proposed steps** for handling them, and where the server keeps user data |
| [STABLE-ID.md](STABLE-ID.md) | Account → draft upload → Item ID/public key → verified key → release build and check; effect on `EXTENSION_IDS` and sessions |
| [RELEASE-PACKAGE.md](RELEASE-PACKAGE.md) | Chrome's image sizes, screenshots, how to rebuild the ZIP |
| `branding/` | `mydubb-icon.svg`, `mydubb-icon-small.svg`, `png/`, `preview.png` |
| `screenshots/` | The four Store screenshots |
| `shots/` | The Playwright spec that makes them |
| `tools/` | `render-icons`, `render-preview`, `key-to-id`, `zip`, `make-zip`, and `release.test.mjs` |

## What is still pending

**Before the policy page goes public**

1. The Product Owner reads the policy against the audit. If the text changes, change the Markdown and
   the HTML together and set "Last updated" to that date (today it is the date of the last content
   change, 2026-11-03, not a date of publication).
2. Read the Microsoft and Render pages again ([PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) §8).
3. Merge and deploy; then open the URL once, without signing in. Only then enter it on the dashboard.

**Needs the Product Owner's decision**

| Item | Decision |
|---|---|
| Carrying out a deletion request | Try the [DATA-REQUESTS.md](DATA-REQUESTS.md) steps on a test account, or build a tool; whether to build the 7-day job-metadata cleanup first. The policy promises neither complete deletion nor a response time meanwhile |
| Postal or contact address (optional) | The policy gives none; add one only if the operator wishes |
| Homepage and support URL for the listing | Where they are |
| Trader or non-trader on the dashboard | Declare |
| How a user asks for an invitation | Whether it is support@mydubb.com |
| A policy for the website | None exists and the footer link names only the extension; whether to write one ([WEBSITE-POLICY-NOTES.md](WEBSITE-POLICY-NOTES.md)) |
| Visibility; reviewer test account and lecture | Choose |
| Upload of the 0.4.1 ZIP, `EXTENSION_IDS` on Render, *Submit for review* | When ready; not done by this work |

**Could not be read here (the policy promises nothing that depends on them)**

| Item | Needs |
|---|---|
| Regions and settings of MyDubb's Azure resources; Render's region | Azure portal, Render dashboard |
| Whether usage rows are in fact written and purged on production | The read-only `usage_report` |
| Dashboard labels on the Privacy practices tab | Reading the live tab before declaring |
| The website's own cookies and analytics (website policy only) | A look at the live site |

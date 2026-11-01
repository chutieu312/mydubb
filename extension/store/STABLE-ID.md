# Stable release ID: procedure and tooling

Status (2026-11-01): **the build and check tooling is done; the key is not.** No developer
account, Store Item ID or verified public key exists, so `store/release-key.json` does not exist
and no release-ready package can be made. Nothing here invents or guesses an ID. Steps marked
**PO** need the Product Owner or the dashboard.

Sources (Chrome documentation, read 2026-10-31; several pages carry old "last updated" stamps, so
confirm in the live dashboard): `developer.chrome.com/docs/extensions/reference/manifest/key`,
`/docs/webstore/publish`, `/docs/webstore/prepare`, `/docs/webstore/register`,
`/docs/webstore/set-up-account`.

## What Chrome documents

- The manifest `key` "maintains the unique ID of an extension … when it is loaded during
  development". The documented way to get it: zip the extension, upload it to the Developer
  Dashboard **without publishing** (*Add new item* → upload), open the **Package** tab →
  **View public key**, copy the text between `-----BEGIN PUBLIC KEY-----` and
  `-----END PUBLIC KEY-----`, remove the newlines, and put it in `manifest.json` as `"key"`.
  Load the unpacked folder and compare its ID with the **Item ID** in the dashboard: "They should
  match."
- Registration is a one-time fee paid when registering as a Chrome Web Store developer (amount
  not stated on the pages read), a verified contact e-mail is required, and the account e-mail
  cannot be changed afterwards (`/docs/webstore/register`).
- ZIP: `manifest.json` in the root, no comments in the manifest, each upload needs a higher
  `version`, 2 GB maximum, description ≤ 132 characters. A new publisher is limited to two
  published extensions.
- **Not stated by the pages read:** whether an uploaded ZIP may keep the `key` field. The key page
  puts the key in the manifest and then says to zip, which suggests it may stay. Unconfirmed: the
  first upload of the keyed ZIP shows it. The first (draft) upload does not need a key.

## Tooling in this repository

| Command (in `extension/`) | Does |
|---|---|
| `npm run build` | `dist/`: the ordinary build, **no `key`**. What Load unpacked and the first draft upload use |
| `npm run check:dist` | Unchanged safety checks (no test hook, permissions, single host, Udemy content script only, no extra manifest fields, **no `key`**) plus: only known files, the four icons exist, are PNG and have their size |
| `npm run package:draft` | `check:dist`, then `release/mydubb-extension-<version>-draft.zip` from `dist/`; reads the ZIP back; prints "DRAFT, NOT RELEASE-READY" and why |
| `node store/tools/key-to-id.mjs <file>` | The extension ID a public key gives. Must equal the dashboard's Item ID |
| `npm run build:release` | `dist-release/` (a **separate folder**, never `dist/`) with the key from `store/release-key.json`. Refuses without that file, when the key does not give the Item ID in it, or for a non-https or localhost origin |
| `npm run check:dist:release` | All of `check:dist` plus the release conditions: the manifest key is exactly the one in `store/release-key.json` and gives its `itemId`; name `MyDubb`; no "Prototype"; description ≤ 132 characters; production https origin. Lists what is missing |
| `npm run package:release` | `check:dist:release`, then `release/mydubb-extension-<version>.zip` from `dist-release/`, read back and compared |

`check:dist` was **not** relaxed: the ordinary build still fails if it carries a key, and release
mode accepts only the one recorded key, never "any key". Tests: `store/tools/release.test.mjs`
(runs in `npm test`).

`store/release-key.json` (to be created in step 6) has this shape; both values are public:

```json
{ "itemId": "<32 letters a-p from the dashboard>", "publicKey": "<one-line key from View public key>" }
```

## Procedure

1. **PO**: create the developer account (decides who the publisher is, pays the fee, verifies the
   contact e-mail). Not done by Claude.
2. `npm ci && npm run build && npm run package:draft`. Check the file list printed.
3. **PO (dashboard)**: *Add new item* → upload `release/mydubb-extension-<version>-draft.zip` as a
   **draft**. Do **not** press *Submit for review* or *Publish*. Write down the **Item ID**.
4. **PO (dashboard)**: Package tab → *View public key* → save the **public** key text in a file
   outside the repository. There is no private key to keep, and none may be created or
   committed here.
5. `node store/tools/key-to-id.mjs <file>`: the printed ID **must equal the Item ID from step 3**.
   If not, stop: the key is wrong or from another item.
6. Only then create `store/release-key.json` with the two verified values and commit it (a public
   key and an ID are not secrets).
7. **Raise the version before the next build and upload.** The draft in step 3 used the version
   in `extension/static/manifest.json` at that time (0.4.0). The next package for the **same
   Store item** (this keyed one, and every later one) must have a **higher** `version` than the
   last one uploaded, or the dashboard refuses it. Edit `"version"` in
   `extension/static/manifest.json` (for example `0.4.1`) **before** step 8; the build copies it
   and the ZIP name carries it. This version has **not** been raised yet: it is a step for the
   preparation of the next upload, and it applies again to every further upload (including a
   re-upload after a fix or a rejection). Commit the change with the package it belongs to.
8. `npm run build:release && npm run check:dist:release && npm run package:release`.
   Load `dist-release/` unpacked **in a separate Chrome profile** and compare its ID in
   `chrome://extensions` with the Item ID. Upload the ZIP (the raised `version`) to the same
   item as the next draft.
9. **PO**: add the Item ID to `EXTENSION_IDS` on Render (below). Not done by Claude.

Until step 6 is done, `package:release` and `check:dist:release` fail with
"verified release key: store/release-key.json does not exist" and the package is a **draft**, not
release-ready. Even with a key, "release-ready" covers the package only; the listing, privacy
declarations, review and publication stay separate and unfinished.

## What changes for the rest of the system

| Place | Effect |
|---|---|
| Server `EXTENSION_IDS` | Add the Item ID **next to** the unpacked ID (JSON list, both allowed). Each ID is its own `client_id` with the redirect `https://<id>.chromiumapp.org/`. Without it, **Connect MyDubb** from the Store build fails with `extension_unknown`. A Render configuration change by the Product Owner; not done and not part of this work |
| Sign-in redirect | `chrome.identity.launchWebAuthFlow` uses the extension's own ID in the redirect, so the Store build needs no code change, only the allowlist entry |
| Session storage | `chrome.storage.session` is per extension: a Store install and an unpacked install do not share the token, drafts, jobs or loaded translation. The user connects again in each |
| The unpacked build you use now | Keeps its path-derived ID **if it stays keyless**: `npm run build` writes `dist/` without a key, as before, and the release build goes to `dist-release/`. Do not load `dist-release/` in the profile that has the keyless folder, and do not put a key into the folder Chrome has loaded: a keyed unpacked folder takes the Store ID, which collides with an installed Store copy and changes the ID of the folder in use. Moving between the two is a re-install and a new "Connect" |
| `EXTENSION_AUTH.md` / `context.md` | Say "Web Store: not done"; they stay true until the Item ID is on the server |

## Not done

Account, upload, Item ID, public key, `store/release-key.json`, `EXTENSION_IDS`, review
submission, publication.

# Stable release ID: procedure (nothing done yet)

Status: **procedure only. No developer account, no Item ID, no public key exist yet.** Nothing in
the manifest, `build.mjs` or `check-dist.mjs` changes in this pull request. The steps that follow
need the Product Owner at the points marked **PO**.

Sources (Chrome documentation, pages read 2026-10-31; several carry old "last updated" stamps, so
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
  cannot be changed afterwards (per `/docs/webstore/register`).
- ZIP: `manifest.json` in the root, no comments in the manifest, each upload needs a higher
  `version`, 2 GB maximum, description ≤ 132 characters. A new publisher is limited to two
  published extensions.
- **Not stated by the pages read:** whether an uploaded ZIP may keep the `key` field. The key page
  puts the key in the manifest and then says to zip, which suggests it may stay. Treat it as
  unconfirmed: the first real upload shows it.

## Procedure

1. **PO**: create the developer account (decides who the publisher is, pays the fee, verifies the
   contact e-mail). Not done by Claude.
2. Build the package: `npm ci && npm run build && npm run check:dist && node store/tools/make-zip.mjs`
   ([RELEASE-PACKAGE.md](RELEASE-PACKAGE.md)). This ZIP has no `key`, as `check:dist` demands today.
3. **PO**: in the dashboard, *Add new item* → upload that ZIP as a **draft**. Do **not** press
   *Submit for review* or *Publish*. Write down the **Item ID** shown for the item.
4. **PO**: Package tab → *View public key* → save the **public** key text in a file outside the
   repository (it is a public key, but the check below is easier from a file). Never download or
   keep a private key; there is none to keep here.
5. Check that the key and the ID belong together:
   `node store/tools/key-to-id.mjs <file>` prints the ID the key gives. It **must equal the Item
   ID from step 3**. If it does not, stop: the key is wrong or from another item.
6. Only then, change the build (a follow-up change, not this PR), keeping `check:dist` strict:
   - the release build puts the verified key in the manifest. The key is read from a file or
     variable set by the person building, or committed as a public constant with the ID next to it;
     the Product Owner chooses. A public key is not a secret.
   - `check:dist` keeps refusing a `key` in an ordinary build, and gets a **separate release mode**
     that requires `key` to be exactly the committed public key, whose derived ID equals the
     committed expected ID. It must not accept any other key, and every existing check stays
     (permissions list, single host, content script match, banned test hooks, no extra manifest
     fields).
7. Rebuild with the key, load that folder unpacked **in a separate Chrome profile** and compare
   its ID in `chrome://extensions` with the Item ID. Upload the new ZIP (higher `version`) as the
   next draft.
8. **PO**: add the Item ID to `EXTENSION_IDS` on Render (see below). Not done by Claude.

## What changes for the rest of the system

| Place | Effect |
|---|---|
| Server `EXTENSION_IDS` | Add the Item ID **next to** the unpacked ID (JSON list, both allowed). Each ID is its own `client_id` with the redirect `https://<id>.chromiumapp.org/`. Without it, **Connect MyDubb** from the Store build fails with `extension_unknown`. Changing it is a Render configuration change by the Product Owner |
| Sign-in redirect | `chrome.identity.launchWebAuthFlow` uses the extension's own ID in the redirect, so the Store build needs no code change, only the allowlist entry |
| Session storage | `chrome.storage.session` is per extension: a Store install and an unpacked install do not share the token, drafts or jobs. The user connects again in each |
| The unpacked build you use now | Keeps its path-derived ID **if it stays keyless**. Do not load the keyed build in the same profile as the unpacked keyless one, and do not put a key into the folder currently loaded: a keyed unpacked folder takes the Store ID, which collides with an installed Store copy and changes the ID of the folder in use. Switching between the two is a re-install and a new "Connect" |
| `check:dist` today | Refuses `key`. Stays so for the ordinary build (step 6) |
| Private key | Never created or stored here. Chrome Web Store signs the published package itself |

## Not done

Account, upload, Item ID, public key, manifest/build change, `EXTENSION_IDS`, review submission,
publication.

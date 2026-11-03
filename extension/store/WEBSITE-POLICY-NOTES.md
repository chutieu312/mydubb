# Notes for a future MyDubb website policy (INTERNAL, not a policy, do not publish)

The Product Owner decided on 2026-11-01 that the published policy covers the extension and its
service requests only ([PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md)). These notes were its
"Appendix A" and are kept as source material in case a website policy is written later. **No
website policy exists**, and nothing here may be published as one without a new review. The `[PO]`
markers are open questions.

Written from `docs/GUEST_ACCESS.md`, `docs/AUTH_API.md`, `docs/API.md` and `docs/ARCHITECTURE.md`,
not from production. The public `GET https://mydubb.com/api/meta` (read 2026-11-01) reports
**guest access enabled** and **YouTube caption import enabled (Supadata)**, so both sections
below describe features that are on; the same answer reports sign-up off and password reset on.
Cookies, analytics and the web server's log retention were not verified. Nothing here promises
more than the code does.

## Cookies

The website uses cookies the server sets and JavaScript cannot read: `mydubb_auth` (your
signed-in session; only its SHA-256 is stored on the server), `mydubb_auth_challenge` (binds a
pending sign-in step, such as choosing a new password, to your browser, short-lived) and, for a
guest, `mydubb_guest`. All are `HttpOnly`, `SameSite=Strict` and `Secure` in production. They are
needed to sign in or to keep a session, not for advertising. `[PO: confirm the site has no
analytics or other cookies]`

## Trying MyDubb as a guest (website only; not available in the extension)

- A guest session is a random token in the `mydubb_guest` cookie, **valid 24 hours** from its
  start. The server stores a hash of the token and a security token for the page, not your name or
  e-mail.
- **Network quota.** To limit use, the server reads the client's network address, reduces it
  (an IPv6 address to its /64 prefix) and stores only a **keyed hash** of it, not the address
  itself, with the guest session and with each guest job. Limits in the code today: 5 jobs per
  guest session, 20 per network per sliding 24 hours, 1,000 words and 10 minutes of audio per
  job, 5 YouTube imports per session. Quota rows are removed by clean-up after they leave the
  24-hour window; rows for a job in progress are kept until it ends. (`/api/meta` reports the
  same limits on production, 2026-11-01: 5 jobs per session, 20 per network per 86,400 s, 1,000
  words, 600 s of audio, session 86,400 s, 5 imports per session, 20 per network.)
- Clearing cookies gives a new guest session, with the same network quota. Signing in to an
  account ends the guest session of that browser.
- Guest jobs are translated and voiced exactly like account jobs (Microsoft Azure, same
  retention as account jobs); the job record keeps no link to a guest session once the session row
  is cleaned up.
- The application's own logs never contain the network address or its hash. The web server's
  access log does print the client address of every request (Render log retention: see
  [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) §8).

## Importing captions from a YouTube link (website only; not in the extension)

- If you paste a YouTube link and choose **Import transcript**, MyDubb's server sends that link
  to **Supadata**, a third-party caption service, asking only for the English captions that
  already exist on the video. The captions come back and fill the form. No job is created and
  Azure is not called by the import.
- MyDubb does not store the link, the video id or the captions for the import (the quota record
  of a guest import holds no link, video or caption), and its logs hold only status codes,
  counts, timing and credits used. What Supadata keeps is governed by Supadata's terms and is not
  verified here. `[PO: link to Supadata's terms]`
- Importing as a guest counts against the import quota above.

## Not promised

No automatic deletion of job records or accounts exists today;
`[PO: whether the website will offer a way to ask for deletion]`.

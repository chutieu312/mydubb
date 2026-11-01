# MyDubb privacy policy (DRAFT, not published, not reviewed)

> **Draft for the Product Owner.** Every `[PO: …]` marker is a fact only the operator can give.
> Nothing here is filled with an invented value. Do not publish until the markers are resolved and
> the Product Owner has read [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md). It is not legal advice; whether
> it also satisfies privacy law that applies to the operator is for the operator to check.
> The sections below the line are the proposed public text.
>
> **Scope decision (Product Owner).** As drafted, this policy is for the **extension** and the
> parts of the MyDubb service the extension uses. It says so and points to a separate website
> policy, which does not exist yet (`[PO: URL when published]`). If the Product Owner prefers one
> policy for both, replace the "does **not** describe the MyDubb website" sentence in "Scope" and append **Appendix A (website)**
> at the end of the public text; Appendix A is written from the code and documents (guest
> sessions, cookies, network quota, YouTube import) and has its own `[PO]` gaps. Until one of the
> two is chosen and published, the dashboard has no valid policy URL.

---

# Privacy policy for MyDubb

Last updated: `[PO: date of publication]`

**Who runs MyDubb:** `[PO: name of the individual or organisation]`, `[PO: postal or contact
address if the operator wishes to give one]`.
**Contact for questions about this policy:** `[PO: e-mail address]`.

## Scope

This policy covers the **MyDubb Chrome extension** and what the MyDubb service (mydubb.com)
does with the requests the extension sends. It does **not** describe the MyDubb website's own
pages (the studio form, guest use, importing captions from a YouTube link, the website's
cookies); those are covered by `[PO: link to the website privacy policy, when it exists]`.

MyDubb is an independent service. It is not made by, endorsed by or connected with Udemy,
Microsoft or Google.

## What the extension is for

The extension takes English transcript text that **you select** on an Udemy lecture page, and,
when you ask, turns it into audio in another language with your MyDubb account, so you can listen
next to the lecture video.

## What the extension reads and when it leaves your browser

| What | When it is read | Where it goes |
|---|---|---|
| The text you select on an Udemy lecture page | When you choose **Send to MyDubb** | Shown in the side panel and kept in your browser's session memory. **Sent to MyDubb only when you click Generate audio** |
| Your choices: start times, language, voice, speed | In the panel | Sent to MyDubb with the text when you click Generate audio |
| The translation MyDubb returns, and the audio | When the job finishes, the panel fetches them | The translation is kept in your browser's session memory so the panel can show it again; the audio is held in memory by the extension's player and is not saved by the extension |
| The lecture's address, page title and the video's time, speed and sound state | While the panel or the floating player is in use | **Stays in your browser.** Not sent to MyDubb. When new audio loads, the extension pauses the lecture video and moves it to where your passage starts; with **Sync with video** on it also mutes the video and changes its speed, and restores them when you turn Sync off |
| Your MyDubb sign-in | When you choose **Connect MyDubb** | You type your password on mydubb.com, not in the extension. The extension receives a sign-in token and your account's e-mail and name, keeps them in your browser's session memory, and sends the token to MyDubb with each request |

**Your text and choices are sent only when you click Generate audio.** Some other requests to
MyDubb happen without a click, and they carry no transcript text:

- Every time the side panel opens, it asks MyDubb for the public list of languages and voices
  (no sign-in token). Like any request, it reaches MyDubb with your network address.
- If the panel holds a sign-in token, it asks MyDubb whether the token is still valid.
- If a job was started in that tab and the panel is closed and opened again, or while a job
  runs, the panel asks MyDubb for the job's status, then its translation and its audio file, and
  keeps doing so until the job ends or you leave the lecture. These requests carry your token and
  the job's id, not your text.
- **Connect MyDubb** and **Disconnect** contact MyDubb when you press them; the sign-in window is
  the MyDubb website, which sets its own cookies (see the website policy).

The extension has no analytics or advertising code and does not read your Udemy account,
cookies or browsing history. `[PO: confirm no analytics or telemetry is added before
publishing]`

## What MyDubb does with your text

- MyDubb translates your text and creates the audio using **Microsoft Azure** services (Translator
  for the translation, Speech for the voice). Your text, and then its translation, are therefore
  **sent to Microsoft**. Microsoft's own terms and privacy statement govern what Microsoft does
  with it. `[PO: link to the Microsoft terms you rely on, and confirm the Azure settings]`
- The transcript is held in the server's memory while the job runs. The translation and the MP3
  are stored on MyDubb's server and deleted `[PO: confirm the production value; the code default
  is 1 hour]` after the job completes.
- MyDubb keeps a **record of each job** (status, voice, language, times, speed, text length,
  which providers were used, any error and which account made it) in its database. **It is not
  deleted automatically today.** `[PO: update this sentence if the proposed clean-up is built]`
  The record does not contain your text.
- MyDubb also keeps a list of English technical terms it found in translations, **without** the
  text, the job or the account they came from.
- Ordinary server logs record technical request details such as the network address. MyDubb's own
  application logs do not contain your text or translations. `[PO: state how long the hosting
  provider keeps access logs once that is known]`

## Your account

Access is by invitation. Your e-mail address, name and a record of your sign-ins are kept to run
your account. Sign-in is handled by Amazon Cognito; MyDubb does not store your password. The
extension's token lasts at most 12 hours.

## Who receives data

Microsoft (Azure Translator and Speech); the infrastructure providers that run MyDubb
(`[PO: confirm: Render for the application and Neon for the database, both in the US West
region as documented, and Amazon Web Services for sign-in]`). MyDubb does not sell your data and
does not use it for advertising or credit decisions, and it does not use it for any purpose
other than providing the dubbing you asked for. `[PO: confirm]` People working on MyDubb do not
read your text except `[PO: state the cases, e.g. with your consent, for security or abuse
investigation, or to follow the law]`.

## Ending it and removing data

- **Disconnect** in the extension removes the token from your browser and ends it on the server.
- **Clear**, closing the Udemy tab, or quitting the browser removes the text and the translation from the extension.
- Uninstalling the extension removes everything it stored in your browser.
- Translations and audio disappear from the server on their own (see above).
- To ask about your account or job records: `[PO: how to ask, what the operator will do and
  within what time. No deletion process exists today; write only what will be done]`.

## Security

The extension talks to MyDubb over HTTPS only. Your token is kept in the extension's session
storage, which Udemy pages cannot read, and the extension never sends your password or cookies.
No system is perfectly secure, and this policy makes no promise beyond this description.

## Chrome Web Store user data policy

The use of information received by the MyDubb extension adheres to the Chrome Web Store User Data
Policy, including the Limited Use requirements.

## Changes

`[PO: how changes will be announced]`

---

# Appendix A: MyDubb website (use ONLY if one policy covers the website too)

Written from `docs/GUEST_ACCESS.md`, `docs/AUTH_API.md`, `docs/API.md` and `docs/ARCHITECTURE.md`,
not from production. Whether each feature is **switched on in production** was not verified here
(guest use is off by default, `GUEST_ACCESS_ENABLED=false`): `[PO: state which are on]`. Remove
what is off. Nothing here promises more than the code does.

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
  24-hour window; rows for a job in progress are kept until it ends. (`[PO: confirm the values
  in production]`)
- Clearing cookies gives a new guest session, with the same network quota. Signing in to an
  account ends the guest session of that browser.
- Guest jobs are translated and voiced exactly like account jobs (Microsoft Azure, same
  retention as above); the job record keeps no link to a guest session once the session row is
  cleaned up.
- The application's own logs never contain the network address or its hash. The web server's
  access log does print the client address of every request; how long the host keeps it is not
  verified here. `[PO]`

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

No automatic deletion of job records or accounts exists today (see the main text);
`[PO: whether the website will offer a way to ask for deletion]`.

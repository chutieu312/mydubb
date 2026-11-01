# MyDubb privacy policy (DRAFT, not published, not reviewed)

> **Draft for the Product Owner.** Every `[PO: …]` marker is a fact only the operator can give.
> Nothing here is filled with an invented value. Do not publish until the markers are resolved and
> the Product Owner has read [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md). It is not legal advice; whether
> it also satisfies privacy law that applies to the operator is for the operator to check.
> The sections below the line are the proposed public text.

---

# Privacy policy for MyDubb

Last updated: `[PO: date of publication]`

**Who runs MyDubb:** `[PO: name of the individual or organisation]`, `[PO: postal or contact
address if the operator wishes to give one]`.
**Contact for questions about this policy:** `[PO: e-mail address]`.

This policy covers the MyDubb website (mydubb.com) and the **MyDubb Chrome extension**. MyDubb is
an independent service. It is not made by, endorsed by or connected with Udemy, Microsoft or
Google.

## What the extension is for

The extension takes English transcript text that **you select** on an Udemy lecture page, and,
when you ask, turns it into audio in another language with your MyDubb account, so you can listen
next to the lecture video.

## What the extension reads and when it leaves your browser

| What | When it is read | Where it goes |
|---|---|---|
| The text you select on an Udemy lecture page | When you choose **Send to MyDubb** | Shown in the side panel and kept in your browser's session memory. **Sent to MyDubb only when you click Generate audio** |
| Your choices: start times, language, voice, speed | In the panel | Sent to MyDubb with the text when you click Generate audio |
| The lecture's address, page title and the video's time, speed and sound state | While the panel or the floating player is in use | **Stays in your browser.** Not sent to MyDubb. With **Sync with video** on, the extension also mutes the lecture video and changes its speed, and restores them when you turn Sync off |
| Your MyDubb sign-in | When you choose **Connect MyDubb** | You type your password on mydubb.com, not in the extension. The extension receives a sign-in token and your account's e-mail and name, keeps them in your browser's session memory, and sends the token to MyDubb with each request |

Other than loading the public list of languages and voices, the extension sends nothing to MyDubb
before you click **Generate audio** or **Connect MyDubb**. It has no analytics or advertising and
does not read your Udemy account, cookies or browsing history. `[PO: confirm no analytics or
telemetry is added before publishing]`

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
- **Clear**, closing the Udemy tab, or quitting the browser removes the text from the extension.
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

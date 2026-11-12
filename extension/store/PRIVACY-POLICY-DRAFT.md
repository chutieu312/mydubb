# MyDubb extension privacy policy (for Product Owner review, not published)

> **Internal note, not part of the public text.** The text below the line is the proposed public
> policy. Its page is [`frontend/public/extension-privacy.html`](../../frontend/public/extension-privacy.html),
> planned for `https://mydubb.com/extension-privacy.html` (**not deployed, not entered on the
> dashboard**). Change both together: the page has the same words.
>
> Before it goes public: the Product Owner reads it against [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md),
> the "Last updated" date is set to the date of the last content change, and the Microsoft and
> Render pages are read again. It is not legal advice; whether it satisfies the privacy law that
> applies to the operator is for the operator to check. Website notes moved to
> [WEBSITE-POLICY-NOTES.md](WEBSITE-POLICY-NOTES.md) and are not part of this policy.

---

# MyDubb Chrome extension privacy policy

Last updated: November 11, 2026

Operator: Can Nguyen

Support and privacy contact: support@mydubb.com

## Scope

This policy covers the MyDubb Chrome extension and the requests it sends to the MyDubb service at
mydubb.com. It is not a privacy policy for the MyDubb website as a whole: it does not describe
website features the extension does not use, such as the studio page, guest use or importing
captions from a YouTube link.

MyDubb is an independent service. It is not made by, endorsed by or connected with Udemy,
Microsoft or Google.

## What the extension is for

The extension takes English transcript text that you paste into its side panel or select on a web page and, when you
ask, turns it into audio in another language with your MyDubb account, so you can listen next to
the video, or with Sync with video together with it.

## What the extension handles in your browser

"Session storage" below is Chrome's session storage for the extension. Chrome clears it when the
browser quits, and web pages cannot read it.

- **The text you select or paste.** When you choose Send to MyDubb on a web page, Chrome gives
  the extension the text you selected there (on an Udemy lecture page the extension reads it from
  the page itself). The extension does not read the content, title or other text of a web page that
  is not an Udemy lecture. Chrome also tells it the address of the page at that moment, so that the
  menu item works on web pages; that address is not stored or sent. The text, or text you paste into the panel, is shown in the side panel and kept in
  session storage. It is sent to MyDubb only when you choose Generate audio.
- **Your choices.** Start times, language, voice and speed. They are kept in session storage and
  sent to MyDubb with the text when you choose Generate audio.
- **The address and title of the current lecture.** Read from the Udemy page in that tab, to tell
  which lecture the panel belongs to and to show its title. They stay in your browser and are not
  sent to MyDubb. This is not your browsing history: the extension has no access to Chrome's
  history. Its page script runs by itself on www.udemy.com only, and on another page only after you
  click the MyDubb button or Send to MyDubb there (next item).
- **The state of the lecture video.** Its time, duration, speed, and whether it is paused or muted.
  Read to show the video controls and to keep audio and video together. It stays in your browser.
  When new audio loads, the extension pauses the lecture video and moves it to where your passage
  starts. With Sync with video on, it also mutes the video and changes its speed, and restores them
  when Sync turns off.
- **The video of another web page, only after you click the MyDubb button or Send to MyDubb on
  it.** Chrome then lets the extension reach that page, in that tab only and until the tab leaves
  that site. The extension places its page script in the page to find its main video: it reads the
  videos' time, duration, size and whether they are paused, muted or looping, and it makes a short
  fingerprint of the page address (not the address itself) to tell later whether the page still
  shows the same video. The fingerprint is kept in session storage with the job; it is not sent to
  MyDubb. To tell that you started a video yourself, it holds in memory the time, the position and
  the page element of your latest pointer press or key press on that page, not which key you pressed
  or what you typed; nothing about it is stored or sent. It does not read the page's text. With Sync
  with video on, it plays, pauses and moves that video, mutes it and changes its speed, and restores
  them when Sync turns off.
- **Pointer and key presses on Udemy, only while Sync with video is on.** The extension notes the time of
  your latest pointer press or key press on the page, to tell a speed you picked from one the site
  put back, and so keep the video coordinated. Only that time is held, in memory. Which key you
  pressed, what you typed and where you pressed are not recorded, and nothing about it is stored or
  sent. This is not keystroke logging or analytics. The floating player's own controls also respond
  to presses on them.
- **The translation and the audio.** When a job finishes, the panel fetches them from MyDubb. The
  translation is kept in session storage together with the account, connection and lecture it
  belongs to, so the panel can show it again. The audio is held in memory by the extension's player
  and is not saved by the extension.
- **Your MyDubb sign-in.** When you choose Connect to MyDubb, you type your password on mydubb.com,
  not in the extension. The extension receives a sign-in token and your account's e-mail and name,
  keeps them in session storage, and sends the token to MyDubb with its requests.
- **Trying MyDubb as a guest.** When you choose Try as guest (offered only when MyDubb offers it),
  mydubb.com continues the guest session this browser already has there, or starts one after you
  confirm. There is no account and no password. The extension receives a sign-in token for that
  guest session and the session's identifier, keeps them in session storage, and sends the token to
  MyDubb with its requests. The jobs you make as a guest count towards the same guest limits on
  mydubb.com and in the extension.

The extension has no analytics or advertising code. It does not read your Udemy account details or
your cookies.

## Requests the extension sends to MyDubb

Your text and choices are sent only when you choose Generate audio. Some other requests happen
without a click, and they carry no transcript text:

- Every time the side panel opens, it asks MyDubb for the public list of languages and voices, with
  no sign-in token. Like any request, it reaches MyDubb with your network address.
- If the panel holds a sign-in token, it asks MyDubb whether the token is still valid and how many
  audio jobs its account or guest session has left. It asks again after MyDubb accepts or refuses a
  Generate because of a limit, and when a job ends.
- If a job was started in that tab and the panel is closed and opened again, or while a job runs,
  the panel asks MyDubb for the job's status, then its translation and its audio file, and keeps
  doing so until the job ends or you leave the lecture. These requests carry your token and the
  job's id, not your text.
- Connect to MyDubb, Try as guest and Disconnect contact MyDubb when you press them. The sign-in
  window is the MyDubb website, which sets the cookies it needs for signing in or for a guest
  session. Create a MyDubb account opens the website's sign-up page in a new tab; the extension sends
  nothing for it.

## What MyDubb does with a request

- **Microsoft Azure.** MyDubb sends your text to Azure Translator (text translation), and the
  translation to Azure Speech (real-time text to speech). Microsoft's own terms and privacy
  statement govern what Microsoft does with it. Microsoft's documentation states that text
  translation "doesn’t store customer data"
  ([Azure Translator](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/translator/data-privacy-security)),
  that "Microsoft doesn't retain or store the text that you provide with the real-time synthesis
  text to speech API", and that "Microsoft doesn't store audio or video content generated with the
  real-time synthesis API"
  ([text to speech](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/data-privacy-security)).
  These are Microsoft's statements about those services, not promises by MyDubb.
- **Your transcript on the server.** It is held in memory while the job runs and is not written to
  MyDubb's database. The server attempts to remove temporary working files when a job finishes. An
  interrupted process or a cleanup failure can leave files behind.
- **The translation and the audio on the server.** They are saved as files so the panel can fetch
  them. They stop being available one hour after the job completes. A cleanup that runs periodically
  then removes the files, so they can stay on the disk for some time after that hour; a server
  restart can also remove them sooner.
- **A record of each job.** Status, voice, language, start times, speed, length of the text, the
  providers used, any error, the times of the job and the account that made it. It does not contain
  your text. It is kept in MyDubb's database after the result has expired, and **it is not deleted
  automatically today**.
- **A usage record of each job.** The client (extension or website), the kind of access, language,
  voice, speed, timing mode, the providers used, the number of characters sent, durations, the size
  of the audio, the outcome and any error code, and for each request to a provider its outcome and
  timing. It is used to measure use and cost. It contains no text, name, e-mail or account id, but
  it is **not anonymous**: it carries the job's id, so anyone who can read MyDubb's database can
  match it to the job record and, through that, to the account. MyDubb's configuration keeps usage
  records for 180 days; a periodic cleanup then removes them, so removal can happen somewhat later.
  Until then they stay even if the job record or the account is removed.
- **A list of technical terms.** English technical terms found in translations, with counts and
  when they were first and last seen, without the text, the job or the account they came from. This
  list is **not deleted automatically**.
- **Logs.** MyDubb's application logs hold counts, status codes and ids, not your text or
  translations. The web server's access log records technical details of each request, including
  your network address, in logs kept by MyDubb's host. Render
  [documents](https://render.com/docs/logging#retention-period) a log retention period of 7 days
  for MyDubb's workspace plan (Hobby). That describes Render's log retention by plan; it is not a
  promise about every internal log of a provider, or about exports or backups.

## Your account

Access is by invitation. MyDubb keeps your e-mail address, your name, your identifier at Amazon
Cognito, your account's status and role, and the time of your last sign-in. Sign-in is handled by
Amazon Cognito, and MyDubb does not store your password. The extension's token lasts at most 12
hours; the server stores only a hash of it, and a periodic cleanup removes that record after the
token has expired or ended. Account records, and records of a change to an account's role, are
**not deleted automatically**.

## Who can see your data at MyDubb

People with the administrator role at MyDubb can open a Usage & Costs page on the MyDubb website,
which shows usage records and reference costs per job. Its API reads the usage records and each
job's status and error code. It returns the job's id, but not an e-mail address, an account id, a
transcript or a translation.

The operator reads your content only when you provide it yourself for support, or when the law
requires it.

## Service providers

- **Microsoft** (Azure Translator and Azure Speech): your text and its translation.
- **Render**: hosts the MyDubb application, its temporary result files and its logs. Requests reach
  Render through a Cloudflare network edge.
- **Neon**: hosts MyDubb's database.
- **Amazon Web Services** (Amazon Cognito): account sign-in.

This policy does not promise that data stays in a particular region or country.

## How your data is not used

MyDubb does not sell user data. It does not transfer user data to others except in the cases the
Chrome Web Store User Data Policy allows, such as the service providers above that are needed to
provide the extension's purpose. It does not use or transfer user data for purposes unrelated to
the extension's purpose, for advertising, or to determine creditworthiness or for lending.

## Ending the connection and removing data from your browser

- **Disconnect** removes the token from your browser and ends it on the server.
- **Clear** empties the transcript text in the panel and removes the saved draft and any selection
  waiting to be shown. It does not remove the translation or the audio already loaded in the player,
  the job being followed or your start times.
- **Your choices** are removed when you close the tab or quit the browser. Moving to another lecture
  blanks the start times.
- **The audio** (kept in memory only) is discarded when a newer result replaces it, when you move to
  another lecture, reload or leave the lecture page, or close the tab, and when you Disconnect or
  connect another account.
- **The saved translation** of the loaded audio is removed when a newer result has loaded and
  replaces it, when you move to another lecture or off the lecture pages, when you Disconnect or the
  connection ends or expires, when another account connects, when you close the tab, and when the
  browser quits. A request that MyDubb refuses, or a job or download that fails, does not remove the
  earlier audio or its translation. Reloading the page keeps the saved translation.
- **Uninstalling** the extension removes everything it stored in your browser.

## Asking about your data

You can ask to access, correct or delete your data by writing to support@mydubb.com. Please write
from the e-mail address of your MyDubb account if you can, and do not send transcripts, passwords or
tokens. The operator verifies who is asking and handles the request as far as is practically
possible and as the law requires.

MyDubb has no automatic deletion of account or job records today. This policy does not promise that
all data can be deleted, or a fixed response time. Nothing here limits any right you have under the
law that applies to you.

## Security

The extension talks to MyDubb over HTTPS only. Your token is kept in the extension's session
storage, and the extension never sends your password or cookies. No system is perfectly secure, and
this policy makes no promise beyond this description.

## Chrome Web Store user data policy

The use of information received by the MyDubb extension adheres to the Chrome Web Store User Data
Policy, including the Limited Use requirements.

## Changes to this policy

When this policy changes, the text on this page and the Last updated date are changed. Additional
notice is given when the law requires it.

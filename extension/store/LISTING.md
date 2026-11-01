# Chrome Web Store listing text (DRAFT)

Status: **draft, English, not entered in the dashboard.** Checked on 2026-11-01 against the merged
side panel (PR #45, `origin/main` `b2a7a40`, extension 0.4.0): one page with three blocks under
each other, *English transcript*, *Translate to*, *Your audio*. Labels are the panel's own. A new
result loads by itself; there is no "Use new audio" step and no tabs.

Rules kept: no "every word in sync", no "unlimited", no price or subscription, no guest, YouTube
or automatic transcript in the extension, no claim that "Video" means any website, no
suggestion that MyDubb is made or endorsed by Udemy, Microsoft or Google. "Udemy" appears
four times in the description (Chrome's spam FAQ: keep one name under 5).

## Item fields

| Field | Text |
|---|---|
| Name | `MyDubb` (the manifest says the same) |
| Category | Education (to confirm on the dashboard's current list) |
| Language | English |
| Short description (manifest `description`, max 132 characters) | `Turn the English transcript you select on a Udemy lecture into audio in your language and play it with the video.` (113; identical to the manifest) |
| Visibility | Start as **Unlisted** or **Private**: the extension needs an invitation account, so a public listing would send users to a sign-in they cannot complete (Product Owner decides; all options go through the same review) |
| Support e-mail | support@mydubb.com (confirmed by the Product Owner; the dashboard still has to verify it) |
| Homepage / support URL | `[PO: URLs]` (mydubb.com is the service's address; whether it is the homepage and has a support page is the Product Owner's decision) |
| Privacy policy URL | `[PO: published URL of PRIVACY-POLICY-DRAFT.md after review]` |
| Screenshots | [screenshots/](screenshots/) (four, 1280×800), see [RELEASE-PACKAGE.md](RELEASE-PACKAGE.md) |

## Detailed description

> MyDubb helps you study English technical lectures in your own language. Select a passage of the
> transcript on an Udemy lecture, send it to MyDubb, and listen to a translated voice next to the
> video.
>
> **How it works**
> 1. Connect your MyDubb account once, with the Connect MyDubb button at the top of the panel.
> 2. On a lecture page, select transcript text, right-click and choose **Send to MyDubb**. The side
>    panel opens with three blocks, one under the other.
> 3. **English transcript**: check the text and the two start times, First and Last sentence
>    starts: where in the video the passage begins and ends. The Video controls show the
>    lecture's current time to help you fill them.
> 4. **Translate to**: choose the language, the voice and the speed, then **Generate audio**.
> 5. **Your audio**: when the audio is ready it loads by itself, paused at its beginning, and the
>    lecture video is paused where the passage starts. The translation is shown above the player.
>    Press Play to listen. Turn on **Sync with video** if you want the video and the audio to play,
>    pause and seek together, or show the floating player on the lecture page.
>
> **What you get**
> - A translation that keeps English technical terms, in one of eight output languages, with a
>   choice of two voices and seven speeds from 0.5x to 2x.
> - A player in the panel and a small floating player on the lecture page; the audio keeps
>   playing when the panel is closed.
> - Generating again does not interrupt what you are listening to. When the new audio is ready it
>   replaces the old one together with its translation; if it fails, the earlier audio stays.
> - Optional **Sync with video**: an estimated alignment of the audio with the passage you sent.
>
> **Good to know**
> - Needs a MyDubb account. Access is by invitation for now; there is no sign-up in the extension
>   and no guest mode.
> - You choose the transcript text and the start times yourself; MyDubb does not read the course
>   or transcribe the video for you.
> - Works on Udemy lecture pages only.
> - Your text and choices are sent to MyDubb when you press Generate audio, and are processed by
>   Microsoft Azure to translate and create the voice. See the privacy policy.
> - The extension pauses the lecture video and moves it to the start of your passage. With Sync
>   on, it also mutes the video and changes its speed. This can affect what Udemy counts as
>   watched.
> - Sync is a timeline estimate, not word by word. Udemy's own speed and volume labels may not
>   show what Sync is controlling.
>
> MyDubb is an independent service and is not affiliated with, endorsed by or sponsored by Udemy,
> Microsoft or Google.

(Udemy appears 4 times in the description, including the disclaimer.)

## Getting started (also for the support page)

1. Ask the operator (Can Nguyen) for an invitation `[PO: how a user asks; support@mydubb.com is the confirmed address, whether invitations are requested there is not]`; activate the account on mydubb.com.
2. Install the extension, open an Udemy lecture you have access to, **reload the tab**.
3. In the panel (toolbar button **Open MyDubb**) choose **Connect MyDubb** and sign in in the
   window that opens. Or select transcript text → right-click → **Send to MyDubb**, then connect.
4. Check the text and the First/Last sentence starts, choose language, voice and speed →
   **Generate audio**.
5. When **Your audio** shows the translation and a paused player, press Play. Turn on **Sync with
   video** if you want it; **Show floating player** keeps the controls on the lecture page.

Enter the times from the video's time while the passage plays; do not guess them from where the
text sits in the transcript. A transcript with timestamps can fill them (**Use the transcript
times**).

## Limits (state them, do not hide them)

- Invitation accounts only; guests cannot use the extension. No payment in the extension.
- Udemy lecture pages only, top frame; quizzes and articles have no video; no YouTube or other
  site in the extension.
- Text you select, not an automatic transcript; no speech-to-text.
- Closing the panel while a job runs: the new audio is loaded when you open the panel again.
- Audio is made per request and kept on the server for a short time (1 hour on production, 2026-11-01); a reload
  needs **Load audio**, and after that time a new Generate. No MP3 download button and no job list.
- Sync is approximate and can drift or switch itself off (for example if the video speed is
  changed). It was tested on a test page, **not yet on the real Udemy player**.
- Real Udemy playback, the real Chrome Web Store build and production behaviour have not been
  verified for this release.

## Support and bug reports

Support e-mail: **support@mydubb.com** (an issue tracker URL, if any, is `[PO]`). Text to show:

> To report a problem, write to support@mydubb.com. Tell us what you did, what you expected, what happened, your Chrome
> version and the extension version (chrome://extensions). Do **not** send transcripts, course
> content, passwords, tokens or screenshots showing your account. A screenshot of the panel
> with the text hidden is enough.

## Reviewer notes (dashboard "Test instructions" tab)

Reviewers cannot use the extension without a MyDubb invitation account **and** an Udemy lecture.
The Product Owner must decide whether to give the review a **disposable** MyDubb account and a
freely viewable lecture, and write the steps (never commit credentials; enter them only in the
dashboard field). `[PO: decision]`

## To confirm before use

- Verified 2026-11-01 from production's `GET /api/meta`: all eight output languages and both
  voices (Andrew Multilingual, Emma Multilingual) are offered, so "eight output languages" and
  "two voices" stand. Re-check on the day the listing is entered.
- The sample screenshots show the same voice label as production ("Andrew Multilingual"); the
  test server lists two languages, production eight.

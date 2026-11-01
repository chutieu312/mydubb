# Chrome Web Store listing text (DRAFT)

Status: **draft, English, not entered in the dashboard.** It describes the **single-page panel**
approved by the Product Owner (three stacked blocks: *English transcript*, *Translate to*, *Your
audio*). That UI is not on `main` yet (PR #45 still builds it), so **re-read every step against
the merged panel and the real Store screenshots before use**. Names of buttons and blocks are
taken from the approved design; if the merged panel words something differently, the panel wins.

Rules kept: no "every word in sync", no "unlimited", no price or subscription, no guest, YouTube
or automatic transcript in the extension, no claim that "Video" means any website, no
suggestion that MyDubb is made or endorsed by Udemy, Microsoft or Google. "Udemy" appears
**under five times** in the description (Chrome's spam FAQ: keep one name under 5 and list at
most five sites).

## Item fields

| Field | Text |
|---|---|
| Name | `MyDubb` (manifest name is still "MyDubb Prototype"; it changes only after #45, see [README.md](README.md)) |
| Category | Education (to confirm on the dashboard's current list) |
| Language | English |
| Short description (manifest `description`, max 132 characters) | `Turn the English transcript you select on a Udemy lecture into audio in your language and play it with the video.` (113) |
| Visibility | Start as **Unlisted** or **Private**: the extension needs an invitation account, so a public listing would send users to a sign-in they cannot complete (Product Owner decides; all options go through the same review) |
| Homepage / support URL | `[PO: URLs]` |
| Privacy policy URL | `[PO: published URL of PRIVACY-POLICY-DRAFT.md after review]` |

## Detailed description

> MyDubb helps you study English technical lectures in your own language. Select a passage of the
> transcript on an Udemy lecture, send it to MyDubb, and get a translated voice you can listen to
> next to the video.
>
> **How it works**
> 1. On a lecture page, select transcript text, right-click and choose **Send to MyDubb**. The
>    side panel opens for that tab.
> 2. **English transcript**: check the text and the two start times (First and Last) that tell
>    MyDubb which part of the video the passage covers. The Video controls in the panel show the
>    lecture's current time to help you fill them.
> 3. **Translate to**: choose the language, the voice and the speed, then **Generate audio**.
> 4. **Your audio**: read the translation shown with the audio, press Play, and, if you wish,
>    turn on **Sync with video** or show the floating player on the lecture page.
>
> **What you get**
> - Translation that keeps English technical terms, with a natural voice in the language you
>   pick.
> - A player in the side panel, and a small floating player that keeps playing when the panel is
>   closed.
> - Optional **Sync with video**: the audio and the lecture video play, pause and seek together
>   across the passage you sent.
>
> **Good to know**
> - Needs a MyDubb account. Access is by invitation for now; there is no sign-up in the extension
>   and no guest mode.
> - You choose the transcript text and the start times yourself; MyDubb does not read the course
>   or transcribe video for you.
> - Works on Udemy lecture pages only.
> - Your selected text and choices are sent to MyDubb when you press Generate audio, and are
>   processed by Microsoft Azure to translate and create the voice. See the privacy policy.
> - Sync follows the passage as a whole; it is not exact word by word. Udemy's own speed and
>   volume labels may not show what Sync is controlling.
>
> MyDubb is an independent service and is not affiliated with, endorsed by or sponsored by Udemy,
> Microsoft or Google.

(Udemy appears 4 times in the description, including the disclaimer; Chrome advises under 5.)

## Getting started (also for the support page)

1. Ask the operator for an invitation `[PO: how a user asks]`; activate the account on mydubb.com.
2. Install the extension, open an Udemy lecture you have access to, **reload the tab**.
3. Select transcript text → right-click → **Send to MyDubb**.
4. In the panel choose **Connect MyDubb** once and sign in in the window that opens.
5. Check the text and the times, choose language, voice and speed → **Generate audio**.
6. In **Your audio**, read the translation, press Play. Press **Use new audio** when a newer
   result is offered and you want it instead of the loaded one.

Entering times: read them from the video while the transcript passage plays; do not guess them
from where the text was selected.

## Limits (state them, do not hide them)

- Invitation accounts only; guests cannot use the extension.
- Udemy lecture pages only, top frame; quizzes and articles have no video; no YouTube or other
  site in the extension.
- Text you select, not an automatic transcript; no speech-to-text.
- Audio is made per request and kept on the server for a short time (default 1 hour), so a new
  Generate is needed after that. No MP3 download button and no job list in the extension.
- Sync is approximate and can drift or switch itself off (for example if the video speed is
  changed); it was tested on a test page, **not yet verified on the real Udemy player**.
- Real Udemy playback, the real Chrome Web Store build and production behaviour have not been
  verified for this release.

## Support and bug reports

`[PO: support e-mail / issue tracker URL]`. Text to show:

> To report a problem, tell us what you did, what you expected, what happened, your Chrome
> version and the extension version (chrome://extensions). Do **not** send transcripts, course
> content, passwords, tokens or screenshots showing your account. A screenshot of the panel
> with the text hidden is enough.

## Reviewer notes (dashboard "Test instructions" tab)

Reviewers cannot use the extension without a MyDubb invitation account **and** an Udemy lecture.
The Product Owner must decide whether to give the review a **disposable** MyDubb account and a
freely viewable lecture, and write the steps (never commit credentials; enter them only in the
dashboard field). `[PO: decision]`

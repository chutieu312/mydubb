# Chrome Web Store listing: 0.5.0

Release candidate for PO approval. Use the existing MyDubb item
`nndofiifflpbhefoehcbfpnaoiohicop`, English, Education, **Public** (PO's updated choice).
The submission copy below assumes extension guests are disabled.

## Summary from package

Manifest description, 123 ASCII characters (maximum 132):

Turn English transcripts into translated audio in Chrome's side panel. Listen independently or sync with compatible videos.

## Description

MyDubb turns English transcript text you provide into translated audio in Chrome's side panel. Generate and listen on ordinary web pages, with or without a compatible video.

How it works
1. Open the MyDubb panel. Choose Create a MyDubb account to register on https://mydubb.com/ and verify your email. Return to the panel and choose Connect to MyDubb to sign in and connect your account.
2. Select English transcript text on a web page, right-click and choose Send to MyDubb, or paste your transcript into the panel. Check the text before generating.
3. Check First sentence starts and Last sentence starts: the times when the first and last sentences begin in your source. A transcript with supported timestamps can fill these times for you.
4. Choose the output language, voice and audio speed, then press Generate audio.
5. Read the translation and press Play to listen. New audio loads paused; it does not play automatically.

Listen your way
- Eight output languages: Vietnamese, Mandarin Chinese (Simplified), Hindi, Spanish, Arabic, French, Russian and Japanese. English technical terms are preserved in the translation.
- Two voices and seven speeds from 0.5x to 2x.
- Listen independently in the panel, including on pages without a supported video. Audio that has loaded can keep playing when you close the panel.
- Optional Sync with video on compatible players, such as Udemy lectures, YouTube watch pages and Loom share pages, when MyDubb identifies the correct player. Open MyDubb on the video tab before generating; if needed, start the intended video so it can be identified.
- Sync follows an estimated timeline over the passage, not individual words or sentences. It can drift or become unavailable. You can still listen independently when Sync is unavailable.
- A floating audio player is available on supported video pages.

Good to know
- This release requires a MyDubb account. Create an account on MyDubb.com, verify your email, then connect it from the panel. Free plan and service limits apply; the panel shows your available Generates.
- You supply the transcript. The extension does not transcribe video or automatically import captions.
- Not every player is supported. Embedded cross-origin players, live streams and pages where the intended video cannot be identified may not support Sync.
- You choose the start times yourself when timestamps are not available. On ordinary pages, selected text may lose line breaks; check it or paste the transcript instead.
- Generate audio sends your transcript and choices to MyDubb and Microsoft Azure for translation and speech generation. See https://mydubb.com/extension-privacy.html.
- With Sync enabled, MyDubb controls playback, seeking, mute and speed of the identified video. On Udemy, loading new audio also pauses the lecture and moves it to the passage start, even with Sync off. This can affect watched progress.
- Generated audio is temporary. If it expires, generate it again.

Support: support@mydubb.com

MyDubb is an independent service, not affiliated with, endorsed by or sponsored by Udemy, YouTube, Loom, Microsoft or Google.

## Dashboard Test instructions (494/500 characters)

Use reviewer credentials to Connect to MyDubb. New users: Create a MyDubb account, verify email on MyDubb.com, return and Connect. Paste English transcript; set start times 000010/000040, Vietnamese, Andrew, 1x; Generate audio, then Play/Pause/seek. For Sync: start a public non-live YouTube watch or Loom share video >1 min; open MyDubb, generate on that tab, enable Sync and confirm. Timeline is estimated; audio also works alone. Guest stays off until after 0.5.0 publication and acceptance.

Enter dedicated reviewer credentials directly in the Dashboard's credential fields; never put
credentials in this document. The Dashboard limits Additional instructions to 500 characters.

## Extended reviewer walkthrough

1. Install MyDubb and open an ordinary HTTPS web page. Click the MyDubb toolbar button to open the side panel.
2. For a new account, choose Create a MyDubb account. Complete registration on MyDubb.com and verify the email using the code delivered to that mailbox. Return to the extension panel and choose Connect to MyDubb. Sign in on MyDubb.com and approve the connection. Alternatively use the dedicated reviewer account supplied in the credential fields.
3. Paste this invented sample into English transcript:
   "A transaction groups changes together. Either all changes succeed, or none of them do. This property is called atomicity."
4. Set First sentence starts to 00:00:10 and Last sentence starts to 00:00:40 (type 000010 and 000040). Choose Vietnamese, Andrew Multilingual and 1x, then Generate audio.
5. Wait for the translation and audio to load. Press Play MyDubb audio; verify Play/Pause and seeking. Closing and reopening the panel should not interrupt already loaded audio.
6. To test Sync, open a public, seekable video at least one minute long on a YouTube watch page or Loom share page, or an accessible Udemy lecture. Start the intended video, then click MyDubb on that tab. Paste the sample and generate again on this video tab with the same times. Once audio is ready, choose Sync with video and confirm Turn on sync. Play, pause and seek using MyDubb. The identified video should follow an estimated timeline; this is not word-by-word alignment. Turn Sync off afterward.
7. If that player's video cannot be identified, Sync is unavailable; independent panel audio remains supported. Try a top-level, non-live player instead of an embedded cross-origin player. No paid course is required for the ordinary-page/audio flow.
8. Extension guest access is disabled for this submission. Try as guest is intentionally absent. It will only be enabled separately after 0.5.0 is published and the production guest flow is accepted; review the account flow above for this submission.

Free plan quotas and temporary service capacity limits apply. Contact support@mydubb.com if review is blocked.

## Future copy: do not submit while extension guests are disabled

After 0.5.0 is Published, the backend guest flag is enabled, and PO acceptance passes:

> Try as guest without an account: choose Try as guest in the panel and confirm on MyDubb.com. Up to 5 audio jobs, each up to 1,000 words and 10 minutes, shared with the website guest session in the same Chrome profile. Session, network and service limits apply. Or create and connect a MyDubb account.

Update the account-required paragraph and reviewer instructions at that time, not before.

## URLs and assets

- Homepage: https://mydubb.com/
- Privacy policy: https://mydubb.com/extension-privacy.html
- Support URL: leave empty until a dedicated public support page is verified; the support email above remains available.
- Four release screenshots: [screenshots/](screenshots/), generated with `npm run store:shots`.
- Keep the existing logo. Optional promo tiles and video are not needed for this release.

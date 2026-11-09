import { useEffect, useRef, useState, type FormEvent } from "react";

import type { TargetLanguageOption, VoiceOption } from "../../api/types";
import { DubbingForm } from "../../features/dubbing/DubbingForm";
import { VIETNAMESE, languageNouns } from "../../lib/languages";

// Fixed sample choices for the form. The real Studio gets its own from GET /api/meta.
const VOICES: VoiceOption[] = [
  {
    id: "AndrewMultilingual",
    label: "Andrew Multilingual",
    provider_voice: "en-US-AndrewMultilingualNeural",
    description: "Warm, clear male voice.",
  },
  {
    id: "EmmaMultilingual",
    label: "Emma Multilingual",
    provider_voice: "en-US-EmmaMultilingualNeural",
    description: "Bright, steady female voice.",
  },
];
const LANGUAGES: TargetLanguageOption[] = [
  VIETNAMESE,
  { id: "spanish", label: "Spanish", noun: "Spanish" },
  { id: "japanese", label: "Japanese", noun: "Japanese" },
];

const languageList = languageNouns(LANGUAGES);
const BLOCKED ="Generate is turned off in this demo. Nothing was sent.";
const noop = () => undefined;

/**
 * The Studio as a new account would first see it, with nothing behind it: it is not signed in, it
 * has no session, and submitting the form is stopped before the form's own handler can run, so no
 * request is ever made. The form's text stays inside this component (it is the form's own state).
 */
export function DemoStudio() {
  const [blocked, setBlocked] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // The screen changed because the user pressed a button: focus follows to its title.
  useEffect(() => heading.current?.focus(), []);

  // Capture phase: runs before DubbingForm's onSubmit, and stopPropagation keeps that from running.
  const stopSubmit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setBlocked(true);
  };

  return (
    <div className="studio-view">
      <section className="hero">
        <p className="eyebrow">Your dubbing studio</p>
        <h1 ref={heading} tabIndex={-1} className="focus-target">
          {/* Same wording rule as the real Studio: no list when there are many languages. */}
          {languageList
            ? `Turn English into ${languageList} audio`
            : "Turn English into audio in your chosen language"}
        </h1>
        <p className="muted">
          Paste a transcript, choose a voice and speed, then listen and download the MP3.
        </p>
      </section>
      <section className="callout" aria-label="Demo Studio">
        <p>
          <strong>Demo Studio.</strong> You are not signed in and no account exists. Generate is
          turned off here.
        </p>
        <p className="small muted">
          Free plan (preview text, not a live counter): 20 Generates and 5 YouTube imports per day.
          Limits reset at 00:00 UTC.
        </p>
      </section>
      <div onSubmitCapture={stopSubmit}>
        <DubbingForm
          voices={VOICES}
          languages={LANGUAGES}
          defaultLanguage={VIETNAMESE.id}
          disclosure={null}
          onJobCreated={noop}
          onSessionExpired={noop}
        />
      </div>
      {blocked && (
        <p className="callout warning" role="alert">
          {BLOCKED}
        </p>
      )}
    </div>
  );
}

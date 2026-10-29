import type { AppMeta } from "../../api/types";

interface Props {
  providers: AppMeta["providers"];
  // The output languages offered, as said in a sentence ("Vietnamese or Mandarin Chinese").
  languages?: string;
}

/** Says, per pipeline component, what is real and what is still a mock. */
export function ProviderBanner({ providers, languages = "Vietnamese" }: Props) {
  const everythingMock = Object.values(providers).every((p) => p === "mock");
  const nothingMock = Object.values(providers).every((p) => p !== "mock");
  if (nothingMock) return null;

  if (everythingMock) {
    return (
      <div className="mock-banner" role="status">
        <strong>Development mock mode.</strong> No Azure services are called. Translations are
        illustrative placeholders and the audio is a fixed sample, not generated from your
        transcript.
      </div>
    );
  }

  return (
    <div className="mock-banner" role="status">
      {summary(providers, languages)}
      <ul className="provider-list">
        <li>Translation: {describe(providers.translation, "Azure Translator (real)")}</li>
        <li>Speech: {describe(providers.speech, "Azure Speech (real)")}</li>
        <li>
          Audio processing:{" "}
          {providers.audio === "mock"
            ? "mock (pass-through: duration not adjusted)"
            : "FFmpeg (real): the audio is adjusted to the target duration"}
        </li>
      </ul>
    </div>
  );
}

function summary(providers: Props["providers"], languages: string) {
  const realTranslation = providers.translation !== "mock";
  const realSpeech = providers.speech !== "mock";
  const adjusted = providers.audio !== "mock";
  if (realSpeech && adjusted) {
    // Audio processing needs real speech, so a mock component here can only be translation.
    return (
      <>
        <strong>Beta: mock translation, real speech, duration adjusted.</strong> The {languages}{" "}
        text is an illustrative placeholder, read aloud by Azure Speech and adjusted to the target
        duration by FFmpeg.
      </>
    );
  }
  if (realTranslation && realSpeech) {
    return (
      <>
        <strong>Beta: real translation and speech, duration not adjusted.</strong> The {languages}{" "}
        text is translated by Azure Translator and read aloud by Azure Speech. The audio length is
        not adjusted to the target duration yet, so it can be longer or shorter than the target.
      </>
    );
  }
  if (realSpeech) {
    return (
      <>
        <strong>Beta: mock translation, real speech.</strong> The {languages} text is an
        illustrative placeholder, read aloud by Azure Speech. The audio length is not adjusted to
        the target duration yet.
      </>
    );
  }
  return (
    <>
      <strong>Beta: real translation, mock audio.</strong> The {languages} text is translated by
      Azure Translator. Speech and audio processing are still mock: the audio is a fixed sample,
      not generated from your transcript, and does not match the target duration.
    </>
  );
}

function describe(provider: string, real: string): string {
  return provider === "mock" ? "mock (placeholder)" : real;
}

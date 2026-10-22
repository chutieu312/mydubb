import type { AppMeta } from "../../api/types";

interface Props {
  providers: AppMeta["providers"];
}

/** Says, per pipeline component, what is real and what is still a mock. */
export function ProviderBanner({ providers }: Props) {
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
      <strong>Beta: real translation, mock audio.</strong> The Vietnamese text is translated by
      Azure Translator. Speech and audio processing are still mock: the audio is a fixed sample,
      not generated from your transcript, and does not match the target duration.
      <ul className="provider-list">
        <li>Translation: {describe(providers.translation, "Azure Translator (real)")}</li>
        <li>Speech: {describe(providers.speech, "Azure Speech (real)")}</li>
        <li>Audio processing: {describe(providers.audio, "FFmpeg (real)")}</li>
      </ul>
    </div>
  );
}

function describe(provider: string, real: string): string {
  return provider === "mock" ? "mock (placeholder)" : real;
}

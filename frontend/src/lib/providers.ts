import type { AppMeta } from "../api/types";

type Providers = AppMeta["providers"];

/**
 * What the user must be told before submitting: which text is sent to which Azure service.
 * `languages` names the output languages offered ("Vietnamese or Mandarin Chinese"). Null when
 * nothing leaves the server (all mock).
 */
export function azureDisclosure(providers: Providers, languages = "Vietnamese"): string | null {
  const translator = providers.translation === "azure";
  const speech = providers.speech === "azure";
  if (translator && speech) {
    return (
      "When you generate dubbing, the transcript text is sent to Microsoft Azure Translator " +
      `to be translated, and the translated ${languages} text is sent to Microsoft Azure ` +
      "Speech to generate the audio."
    );
  }
  if (translator) {
    return (
      "When you generate dubbing, the transcript text is sent to Microsoft Azure Translator " +
      "to be translated."
    );
  }
  if (speech) {
    return (
      `When you generate dubbing, the ${languages} text (here a mock placeholder that still ` +
      "contains your transcript text) is sent to Microsoft Azure Speech to generate the audio."
    );
  }
  return null;
}

/**
 * One line shown next to the submit button: the same fact as azureDisclosure(), without the
 * detail. Null when nothing leaves the server (all mock).
 */
export function azureDisclosureShort(providers: Providers): string | null {
  const translator = providers.translation === "azure";
  const speech = providers.speech === "azure";
  if (translator && speech) {
    return "Your text is sent to Microsoft Azure to translate it and create the audio.";
  }
  if (translator) return "Your text is sent to Microsoft Azure to be translated.";
  if (speech) return "Your text is sent to Microsoft Azure to create the audio.";
  return null;
}

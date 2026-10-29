import type { AppMeta, TargetLanguageOption } from "../api/types";

// What a job or result without a language means: everything made before the option existed was
// Vietnamese. Used only for display; the server decides a job's language.
export const VIETNAMESE: TargetLanguageOption = {
  id: "vietnamese",
  label: "Vietnamese",
  noun: "Vietnamese",
  translator_language: "vi",
};

export interface LanguageChoice {
  // Offered in "Translate to", in the server's order; empty when the server reports none.
  options: TargetLanguageOption[];
  // What the form starts with (the server's default).
  defaultId: string;
}

/** How a stored job's language is shown. */
export interface JobLanguage {
  // The server's label ("Chinese — Mandarin (Simplified)").
  label: string;
  // Inside a sentence ("Mandarin Chinese translation").
  noun: string;
  // Language tag of the translated text (`lang` attribute), when known.
  tag?: string;
  // Direction of the translated text (`dir` attribute): "rtl" for Arabic.
  dir?: "ltr" | "rtl";
}

function isOption(value: unknown): value is TargetLanguageOption {
  const item = value as Partial<TargetLanguageOption> | null;
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.id === "string" &&
    item.id !== "" &&
    typeof item.label === "string" &&
    typeof item.noun === "string"
  );
}

/** The output languages from GET /api/meta. Nothing is invented when the server lists none. */
export function languageChoiceOf(meta: AppMeta): LanguageChoice {
  const options = Array.isArray(meta.target_languages) ? meta.target_languages.filter(isOption) : [];
  const preferred = meta.default_target_language;
  const defaultId =
    preferred !== undefined && options.some((o) => o.id === preferred)
      ? preferred
      : (options[0]?.id ?? "");
  return { options, defaultId };
}

/** A stored job's language; a job without the field is Vietnamese. */
export function jobLanguage(
  job: { target_language?: string; target_language_label?: string },
  options: TargetLanguageOption[],
): JobLanguage {
  const id = job.target_language ?? VIETNAMESE.id;
  const known = options.find((o) => o.id === id) ?? (id === VIETNAMESE.id ? VIETNAMESE : null);
  return {
    label: job.target_language_label ?? known?.label ?? id,
    noun: known?.noun ?? job.target_language_label ?? id,
    tag: known?.translator_language,
    dir: known?.text_direction === "rtl" ? "rtl" : known ? "ltr" : undefined,
  };
}

// More languages than this are not listed in a sentence: the wording says "your chosen language".
const MAX_NAMED_LANGUAGES = 2;

/**
 * "Vietnamese", "Vietnamese or Mandarin Chinese": the languages a text may be translated into, as
 * said in a sentence. Null when the server offers more than two (the sentence then speaks of "your
 * chosen language" or "the translated text" instead of listing them all).
 */
export function languageNouns(options: TargetLanguageOption[]): string | null {
  const nouns = options.length > 0 ? options.map((o) => o.noun) : [VIETNAMESE.noun];
  if (nouns.length > MAX_NAMED_LANGUAGES) return null;
  const last = nouns.at(-1) ?? VIETNAMESE.noun;
  return nouns.length === 1 ? last : `${nouns.slice(0, -1).join(", ")} or ${last}`;
}

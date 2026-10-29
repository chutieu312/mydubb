import type { TargetLanguageOption } from "../../api/types";
import { FieldMessage } from "./FieldMessage";

interface Props {
  languages: TargetLanguageOption[];
  value: string;
  onChange: (language: string) => void;
  error?: string;
}

/** "Translate to": the output language of the next job (the transcript is always English). */
export function LanguageField({ languages, value, onChange, error }: Props) {
  return (
    <div className="field">
      <label htmlFor="target-language">Translate to</label>
      <select
        id="target-language"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "target-language-error" : undefined}
      >
        {languages.map((language) => (
          <option key={language.id} value={language.id}>
            {language.label}
          </option>
        ))}
      </select>
      <FieldMessage message={error} id="target-language-error" />
    </div>
  );
}

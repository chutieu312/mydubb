import type { VoiceOption } from "../../api/types";
import { FieldMessage } from "./FieldMessage";

interface Props {
  voices: VoiceOption[];
  value: string;
  onChange: (voice: string) => void;
  error?: string;
}

export function VoiceField({ voices, value, onChange, error }: Props) {
  return (
    <fieldset className="field">
      <legend>Voice</legend>
      <div className="voice-list">
        {voices.map((v) => (
          <label key={v.id} className="voice-option">
            <input
              type="radio"
              name="voice"
              value={v.id}
              checked={value === v.id}
              onChange={() => onChange(v.id)}
            />
            <span>
              <strong>{v.label}</strong> <small className="muted">{v.description}</small>
            </span>
          </label>
        ))}
      </div>
      <FieldMessage message={error} />
    </fieldset>
  );
}

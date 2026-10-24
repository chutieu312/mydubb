import { AUDIO_SPEEDS, speedLabel } from "../../lib/speed";
import { FieldMessage } from "./FieldMessage";

interface Props {
  value: number;
  onChange: (speed: number) => void;
  error?: string;
}

export function SpeedField({ value, onChange, error }: Props) {
  return (
    <fieldset className="field">
      <legend>Audio speed</legend>
      <div className="speed-group">
        {AUDIO_SPEEDS.map((option) => (
          <label key={option} className="speed-option">
            <input
              type="radio"
              name="speed"
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{speedLabel(option)}</span>
          </label>
        ))}
      </div>
      <FieldMessage message={error} />
    </fieldset>
  );
}

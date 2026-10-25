import type { ChangeEvent } from "react";

import { editTimestamp } from "../../lib/timestampInput";
import { FieldMessage } from "./FieldMessage";

interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

// A plain text input (not type="number": that would drop leading zeros and the colons). The user
// types digits and the colons appear; see lib/timestampInput.ts for the editing rules.
export function TimestampInput({ id, label, value, onChange, error }: Props) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const native = event.nativeEvent as Partial<InputEvent>;
    const result = editTimestamp({
      previous: value,
      next: input.value,
      caret: input.selectionStart ?? input.value.length,
      inputType: native.inputType ?? "",
      data: native.data ?? null,
    });
    // Write the result into the DOM now. React then finds nothing to change and leaves the caret
    // where it is, instead of moving it to the end after every edit.
    if (input.value !== result.value) input.value = result.value;
    input.setSelectionRange(result.caret, result.caret);
    if (result.value !== value) onChange(result.value);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder="HH:MM:SS"
        value={value}
        onChange={handleChange}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      <span id={hintId} className="sr-only">
        Type the digits only. The colons are added automatically, for example 000130 becomes
        00:01:30.
      </span>
      <FieldMessage message={error} id={errorId} />
    </div>
  );
}

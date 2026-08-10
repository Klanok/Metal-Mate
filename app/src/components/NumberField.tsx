/**
 * A millimetre field.
 *
 * Keeps what the user typed in local state and only reports parseable values
 * upward. Without that, clearing the box to retype a number would push NaN (or
 * a snapped-back old value) into the parameters and the part would flicker or
 * fail to regenerate mid-keystroke.
 */

import { useEffect, useState } from 'react';

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly step?: number;
  readonly unit?: string;
}

export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  unit = 'mm',
}: NumberFieldProps): JSX.Element {
  const [text, setText] = useState(() => String(value));

  // Follow the value when it changes from outside (loading a project, style
  // defaults), but not while the user is mid-edit on the same number.
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  const parsed = Number(text);
  const invalid = text.trim() === '' || !Number.isFinite(parsed);

  return (
    <label className={`field number${invalid ? ' invalid' : ''}`}>
      <span>{label}</span>
      <span className="number-input">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const next = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(next)) onChange(next);
          }}
          onBlur={() => {
            if (invalid) setText(String(value));
          }}
        />
        <span className="unit">{unit}</span>
      </span>
    </label>
  );
}

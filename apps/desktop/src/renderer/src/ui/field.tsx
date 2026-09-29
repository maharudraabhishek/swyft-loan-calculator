import { useId, type ReactNode } from 'react';

/**
 * Labelled input with hint and error wired for assistive technology
 * (`aria-invalid`, `aria-describedby`). The error text sits next to the input.
 */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  prefix,
  suffix,
  type = 'text',
  inputMode,
  placeholder,
  list,
  required = false,
  autoFocus = false,
  name,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly type?: 'text' | 'date';
  readonly inputMode?: 'decimal' | 'numeric' | 'text';
  readonly placeholder?: string;
  readonly list?: string;
  readonly required?: boolean;
  readonly autoFocus?: boolean;
  readonly name?: string;
}): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <div className="input-wrap">
        {prefix && (
          <span className="affix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={id}
          name={name}
          type={type}
          value={value}
          inputMode={inputMode}
          placeholder={placeholder}
          list={list}
          required={required}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && (
          <span className="affix" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled = false,
  appearance = 'checkbox',
}: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  /** `switch`: an on/off toggle (native checkbox announced as a switch). */
  readonly appearance?: 'checkbox' | 'switch';
}): React.JSX.Element {
  const isSwitch = appearance === 'switch';
  return (
    <label className={isSwitch ? 'checkbox switch' : 'checkbox'}>
      <input
        type="checkbox"
        role={isSwitch ? 'switch' : undefined}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

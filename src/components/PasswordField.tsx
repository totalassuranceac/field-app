import { useId, useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Optional label text above the field */
  label?: string;
  /** Extra class on the outer wrapper */
  wrapperClassName?: string;
};

/**
 * Password input with Show / Hide so first-time setup and sign-in can verify spelling.
 */
export function PasswordField({
  label,
  wrapperClassName = "",
  className = "",
  id,
  ...inputProps
}: Props) {
  const [visible, setVisible] = useState(false);
  const autoId = useId();
  const inputId = id || autoId;

  return (
    <div className={`password-field ${wrapperClassName}`.trim()}>
      {label != null && label !== "" ? (
        <label htmlFor={inputId} className="password-field-label">
          {label}
        </label>
      ) : null}
      <div className="password-field-row">
        <input
          {...inputProps}
          id={inputId}
          type={visible ? "text" : "password"}
          className={`password-field-input ${className}`.trim()}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button
          type="button"
          className="password-field-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          tabIndex={0}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

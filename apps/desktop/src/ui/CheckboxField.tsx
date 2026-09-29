import { forwardRef, type ChangeEventHandler, type ReactNode, useEffect, useId, useRef } from "react";

export interface CheckboxFieldProps {
  checked?: boolean;
  defaultChecked?: boolean;
  description?: string;
  disabled?: boolean;
  id?: string;
  indeterminate?: boolean;
  label: ReactNode;
  ariaLabel?: string;
  name?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  value?: string;
}

/**
 * Native checkbox wrapped by its label so the box and the text share one
 * click target. The accessible name stays exactly the label text; the
 * optional description is announced through `aria-describedby`.
 */
export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(
  function CheckboxField(
    {
      checked,
      defaultChecked,
      description,
      disabled,
      id,
      indeterminate = false,
      label,
      ariaLabel,
      name,
      onChange,
      value,
    },
    ref,
  ) {
    const generatedId = useId();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const inputId = id ?? generatedId;
    const labelId = `${inputId}-label`;
    const descriptionId = description ? `${inputId}-description` : undefined;

    useEffect(() => {
      if (inputRef.current) inputRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <label className="sh-checkbox-field" htmlFor={inputId}>
        <input
          aria-describedby={descriptionId}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : labelId}
          checked={checked}
          className="sh-checkbox-field__input"
          defaultChecked={defaultChecked}
          disabled={disabled}
          id={inputId}
          name={name}
          onChange={onChange}
          ref={(element) => {
            inputRef.current = element;
            if (typeof ref === "function") ref(element);
            else if (ref) ref.current = element;
          }}
          type="checkbox"
          value={value}
        />
        <span className="sh-checkbox-field__text">
          <span className="sh-checkbox-field__label" id={labelId}>
            {label}
          </span>
          {description ? (
            <span
              className="sh-checkbox-field__description"
              id={descriptionId}
            >
              {description}
            </span>
          ) : null}
        </span>
      </label>
    );
  },
);

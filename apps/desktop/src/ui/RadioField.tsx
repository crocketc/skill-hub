import { forwardRef, type ChangeEventHandler, useId } from "react";

export interface RadioFieldProps {
  checked?: boolean;
  defaultChecked?: boolean;
  description?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  name?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  value?: string;
}

/**
 * Native radio wrapped by its label, mirroring `CheckboxField`: the box and
 * the text share one click target, the accessible name stays exactly the
 * label text and the optional description is announced through
 * `aria-describedby`. Radios sharing a `name` keep native group semantics
 * (arrow-key walking, one selection per group).
 */
export const RadioField = forwardRef<HTMLInputElement, RadioFieldProps>(
  function RadioField(
    {
      checked,
      defaultChecked,
      description,
      disabled,
      id,
      label,
      name,
      onChange,
      value,
    },
    ref,
  ) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const labelId = `${inputId}-label`;
    const descriptionId = description ? `${inputId}-description` : undefined;

    return (
      <label className="sh-radio-field" htmlFor={inputId}>
        <input
          aria-describedby={descriptionId}
          aria-labelledby={labelId}
          checked={checked}
          className="sh-radio-field__input"
          defaultChecked={defaultChecked}
          disabled={disabled}
          id={inputId}
          name={name}
          onChange={onChange}
          ref={ref}
          type="radio"
          value={value}
        />
        <span className="sh-radio-field__text">
          <span className="sh-radio-field__label" id={labelId}>
            {label}
          </span>
          {description ? (
            <span className="sh-radio-field__description" id={descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      </label>
    );
  },
);

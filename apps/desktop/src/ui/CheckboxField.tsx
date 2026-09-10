import { forwardRef, type ChangeEventHandler, useId } from "react";

export interface CheckboxFieldProps {
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
      <label className="sh-checkbox-field" htmlFor={inputId}>
        <input
          aria-describedby={descriptionId}
          aria-labelledby={labelId}
          checked={checked}
          className="sh-checkbox-field__input"
          defaultChecked={defaultChecked}
          disabled={disabled}
          id={inputId}
          name={name}
          onChange={onChange}
          ref={ref}
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

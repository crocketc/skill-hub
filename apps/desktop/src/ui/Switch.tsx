import { forwardRef, type ChangeEventHandler } from "react";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  /** 关联帮助/错误说明的元素 id（aria-describedby）。 */
  describedBy?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  name?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
}

/**
 * Binary control for settings that take effect immediately. Built on a
 * native checkbox with `role="switch"` so pointer and keyboard share the
 * same behavior and state announcement.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  function Switch(
    { checked, defaultChecked, describedBy, disabled, id, label, name, onChange },
    ref,
  ) {
    return (
      <label className="sh-switch">
        <input
          checked={checked}
          className="sh-switch__input"
          aria-describedby={describedBy}
          defaultChecked={defaultChecked}
          disabled={disabled}
          id={id}
          name={name}
          onChange={onChange}
          ref={ref}
          role="switch"
          type="checkbox"
        />
        <span aria-hidden="true" className="sh-switch__track">
          <span className="sh-switch__thumb" />
        </span>
        <span className="sh-switch__label">{label}</span>
      </label>
    );
  },
);

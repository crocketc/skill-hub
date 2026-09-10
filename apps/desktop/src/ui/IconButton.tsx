import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Registry name of the decorative glyph. */
  icon: IconName;
  /** Required accessible name; the glyph itself is hidden from AT. */
  label: string;
}

/**
 * Icon-only action with at least a 40×40px click target (enforced in
 * `styles/base.css`) and an explicit accessible name.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ icon, label, type = "button", ...props }, ref) {
    return (
      <button
        {...props}
        aria-label={label}
        className={["sh-icon-button", props.className]
          .filter(Boolean)
          .join(" ")}
        ref={ref}
        type={type}
      >
        <Icon name={icon} size={20} />
      </button>
    );
  },
);

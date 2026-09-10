import { forwardRef, type SelectHTMLAttributes } from "react";
import { useFieldControlAria } from "./Field";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Native select styled with theme control tokens. The native popup keeps
 * full keyboard support and follows `color-scheme`, which keeps options
 * readable on Windows dark mode.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    { "aria-describedby": describedBy, className, children, id, ...props },
    ref,
  ) {
    const fieldAria = useFieldControlAria({ describedBy });

    return (
      <select
        {...props}
        aria-describedby={fieldAria["aria-describedby"]}
        aria-invalid={fieldAria["aria-invalid"]}
        aria-required={fieldAria["aria-required"]}
        className={["sh-select", className].filter(Boolean).join(" ")}
        id={fieldAria.id ?? id}
        ref={ref}
      >
        {children}
      </select>
    );
  },
);

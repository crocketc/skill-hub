import { forwardRef, type InputHTMLAttributes } from "react";
import { useFieldControlAria } from "./Field";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { "aria-describedby": describedBy, className, id, ...props },
  ref,
) {
  const fieldAria = useFieldControlAria({ describedBy });

  return (
    <input
      {...props}
      aria-describedby={fieldAria["aria-describedby"]}
      aria-invalid={fieldAria["aria-invalid"]}
      aria-required={fieldAria["aria-required"]}
      className={["sh-input", className].filter(Boolean).join(" ")}
      id={fieldAria.id ?? id}
      ref={ref}
    />
  );
});

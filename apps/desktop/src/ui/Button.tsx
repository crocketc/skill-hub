import { forwardRef, type ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled,
    loading = false,
    size = "md",
    type = "button",
    variant = "primary",
    ...props
  },
  ref,
) {
  const classes = [
    "sh-button",
    `sh-button--${variant}`,
    `sh-button--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={classes}
      disabled={disabled || loading}
      ref={ref}
      type={type}
    >
      {loading ? (
        <svg
          aria-hidden="true"
          className="sh-button__spinner"
          data-loading-indicator=""
          fill="none"
          viewBox="0 0 16 16"
        >
          <circle
            cx="8"
            cy="8"
            r="6.25"
            opacity="0.25"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
          />
        </svg>
      ) : null}
      {children}
    </button>
  );
});

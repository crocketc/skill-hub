import {
  createContext,
  type ReactNode,
  useContext,
  useId,
} from "react";

interface FieldContextValue {
  controlId: string;
  describedBy: string | undefined;
  hasError: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldControlAria {
  id: string | undefined;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  "aria-required": true | undefined;
}

/**
 * Wires a control into its surrounding Field: label `id`, help/error
 * `aria-describedby`, required and invalid states. The field owns the
 * control id; explicit `aria-describedby` values merge alongside the
 * field-provided ones.
 */
export function useFieldControlAria(options: {
  describedBy?: string;
} = {}): FieldControlAria {
  const field = useContext(FieldContext);
  const describedByParts = [options.describedBy, field?.describedBy].filter(
    (value): value is string => Boolean(value),
  );

  return {
    "aria-describedby": describedByParts.length
      ? describedByParts.join(" ")
      : undefined,
    "aria-invalid": field?.hasError ? true : undefined,
    "aria-required": field?.required ? true : undefined,
    id: field?.controlId,
  };
}

export interface FieldProps {
  children: ReactNode;
  /**
   * Optional explicit control id, shared by the label `htmlFor` and the
   * control `id`. When omitted, a stable generated id is used.
   */
  id?: string;
  error?: string;
  help?: string;
  label: string;
  required?: boolean;
}

export function Field({
  children,
  error,
  help,
  id,
  label,
  required = false,
}: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="sh-field">
      <label className="sh-field__label" htmlFor={controlId}>
        {label}
        {required ? (
          <span aria-hidden="true" className="sh-field__required">
            *
          </span>
        ) : null}
      </label>
      <FieldContext.Provider
        value={{
          controlId,
          describedBy,
          hasError: Boolean(error),
          required,
        }}
      >
        {children}
      </FieldContext.Provider>
      {help ? (
        <p className="sh-field__help" id={helpId}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p className="sh-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

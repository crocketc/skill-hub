/**
 * Moves keyboard focus to the first control marked `aria-invalid="true"`
 * inside `container` (defaults to the document) after a failed submit.
 *
 * Returns `true` when an invalid control exists and now holds focus.
 */
export function focusFirstInvalidField(
  container: ParentNode = document,
): boolean {
  const invalid = container.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!invalid) {
    return false;
  }
  invalid.focus();
  return document.activeElement === invalid;
}

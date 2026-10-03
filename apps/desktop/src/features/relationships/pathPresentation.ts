import { displayPath } from "../../platform/displayPath";

export interface RelationshipPathPresentation {
  /** Normalized full path for accessible labels and tooltips. */
  fullPath: string;
  /** Compact label that keeps the most useful trailing path segments. */
  label: string;
}

/**
 * Paths in relationship cards and graph nodes should identify the destination
 * without forcing their container wider. Keep the full normalized value for
 * hover and keyboard access, and elide only the leading directories.
 */
export function presentRelationshipPath(
  path: string,
  maxCharacters = 44,
): RelationshipPathPresentation {
  const fullPath = displayPath(path);
  const limit = Math.max(8, Math.floor(maxCharacters));
  if (fullPath.length <= limit) return { fullPath, label: fullPath };

  const separator = fullPath.includes("\\") ? "\\" : "/";
  const segments = fullPath.split(/[\\/]+/).filter(Boolean);
  const suffix = segments.slice(-3).join(separator);
  const availableSuffixLength = Math.max(4, limit - 2);
  const compactSuffix = suffix.length > availableSuffixLength
    ? suffix.slice(-availableSuffixLength)
    : suffix;

  return {
    fullPath,
    label: `…${separator}${compactSuffix}`,
  };
}

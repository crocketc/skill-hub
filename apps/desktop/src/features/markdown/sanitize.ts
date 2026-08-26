export type MarkdownUrlClassification =
  | { kind: "blocked" }
  | { fragment: string; kind: "fragment" }
  | { kind: "external"; target: string }
  | { kind: "local"; path: string };

export function normalizeSkillRelativePath(input: string): string | null {
  const candidate = input.trim();
  if (!candidate || candidate.startsWith("/") || candidate.includes("\\")) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }

  if (
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes(":")
  ) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join("/") : null;
}

export function classifyMarkdownUrl(input: string): MarkdownUrlClassification {
  const candidate = input.trim();
  if (candidate.startsWith("#") && candidate.length > 1) {
    return { fragment: candidate.slice(1), kind: "fragment" };
  }
  if (candidate.startsWith("//")) {
    return { kind: "blocked" };
  }

  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "external", target: url.href };
    }
    return { kind: "blocked" };
  } catch {
    const path = normalizeSkillRelativePath(candidate);
    return path ? { kind: "local", path } : { kind: "blocked" };
  }
}

import "./BrandTag.css";

/**
 * Known brand profile ids and their catalog spelling. Keys are lowercase
 * profile ids (or accepted display-name spellings) so both "openai" and
 * "OpenAI" resolve to the same tag. Mirrors the adapter profile catalog
 * documented in features/skills/AgentDeploymentIcons.tsx.
 */
const BRAND_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude",
  claude: "Claude",
  cline: "Cline",
  codebuddy: "CodeBuddy",
  codex: "Codex",
  comate: "CoMate",
  cursor: "Cursor",
  gemini: "Gemini",
  "github-copilot": "GitHub Copilot",
  google: "Gemini",
  grok: "Grok",
  hermes: "Hermes",
  kimi: "Kimi",
  openai: "OpenAI",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
  qoder: "Qoder",
  trae: "Trae",
  windsurf: "Windsurf",
  zcode: "ZCode",
};

/** Lowercases and unifies separators so display names and profile ids agree. */
export function normalizeBrandKey(brand: string): string {
  return brand.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Friendly catalog name for known brands; generic Title Case otherwise. */
export function brandDisplayName(brand: string): string {
  const key = normalizeBrandKey(brand);
  const known = BRAND_DISPLAY_NAMES[key];
  if (known) return known;
  return brand
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Deterministic preset brand color class per profile id; unknown brands share
 * the neutral tag style. Colors themselves live in BrandTag.css.
 */
export function brandColorClass(brand: string): string {
  const key = normalizeBrandKey(brand);
  return key in BRAND_DISPLAY_NAMES
    ? `sh-brand-tag--${key}`
    : "sh-brand-tag--neutral";
}

export interface BrandTagProps {
  /** Brand profile id (e.g. "openai") or raw display name (e.g. "Acme"). */
  brand: string;
}

export function BrandTag({ brand }: BrandTagProps): JSX.Element | null {
  const key = normalizeBrandKey(brand);
  if (!key) return null;
  return (
    <span className={`sh-brand-tag ${brandColorClass(brand)}`} title={brand.trim()}>
      {brandDisplayName(brand)}
    </span>
  );
}

import "./BrandTag.css";

/**
 * Known brand profile ids and their catalog spelling. Keys are lowercase
 * profile ids (or accepted display-name spellings) so both "openai" and
 * "OpenAI" resolve to the same tag. Mirrors the adapter profile catalog
 * documented in features/skills/AgentDeploymentIcons.tsx. Exported so tests
 * can lock the BrandTag.css color classes to the catalog.
 */
export const BRAND_DISPLAY_NAMES: Record<string, string> = {
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
 * QA-014：已知品牌对应的内置 Logo 素材（public/brand/agents/lobehub/）。
 * 每个条目都必须指向真实存在的素材文件（BrandTag.test.tsx 做双向完整性
 * 校验）；没有素材的品牌（如 comate）保持颜色标签回退，不伪造图标。
 */
export const BRAND_ICON_FILES: Record<string, string> = {
  anthropic: "anthropic.svg",
  claude: "anthropic.svg",
  cline: "cline.svg",
  codebuddy: "codebuddy.svg",
  codex: "codex.svg",
  cursor: "cursor.svg",
  gemini: "gemini.svg",
  "github-copilot": "github-copilot.svg",
  google: "gemini.svg",
  grok: "grok.svg",
  hermes: "hermes-agent.svg",
  kimi: "kimi.svg",
  openai: "openai.svg",
  openclaw: "openclaw.svg",
  opencode: "opencode.svg",
  qoder: "qoder.svg",
  trae: "trae.svg",
  windsurf: "windsurf.svg",
  zcode: "zai.svg",
};

/** Bundled logo asset URL for known brands; null keeps the color-tag fallback. */
export function brandIconSrc(brand: string): string | null {
  const file = BRAND_ICON_FILES[normalizeBrandKey(brand)];
  return file ? `/brand/agents/lobehub/${file}` : null;
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
  const icon = brandIconSrc(brand);
  return (
    <span className={`sh-brand-tag ${brandColorClass(brand)}`} title={brand.trim()}>
      {icon ? (
        <img
          alt=""
          aria-hidden="true"
          className="sh-brand-tag__icon"
          height={20}
          src={icon}
          width={20}
        />
      ) : null}
      {brandDisplayName(brand)}
    </span>
  );
}

import i18next, { createInstance, type i18n } from "i18next";
import enUS from "./en-US/common.json";
import zhCN from "./zh-CN/common.json";

export type SupportedLocale = "en-US" | "zh-CN";
type TranslationTree = Record<string, unknown>;

export const resources = {
  "en-US": { translation: enUS },
  "zh-CN": { translation: zhCN },
} as const;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: (typeof resources)["en-US"];
  }
}

export function resolveLocale(
  preferredLanguages: readonly string[],
): SupportedLocale {
  for (const language of preferredLanguages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh")) {
      return "zh-CN";
    }
    if (normalized.startsWith("en")) {
      return "en-US";
    }
  }

  return "en-US";
}

export function flattenTranslationKeys(tree: TranslationTree): string[] {
  const keys: string[] = [];

  function visit(node: TranslationTree, prefix: string) {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        visit(value as TranslationTree, path);
      } else {
        keys.push(path);
      }
    }
  }

  visit(tree, "");
  return keys.sort();
}

function i18nOptions(preferredLanguages: readonly string[]) {
  return {
    fallbackLng: "en-US",
    initImmediate: false,
    interpolation: { escapeValue: false },
    lng: resolveLocale(preferredLanguages),
    resources,
    returnNull: false,
  } as const;
}

export async function createSkillHubI18n(
  preferredLanguages: readonly string[],
): Promise<i18n> {
  const instance = createInstance();
  await instance.init(i18nOptions(preferredLanguages));
  return instance;
}

const detectedLanguages =
  typeof navigator === "undefined" ? ["en-US"] : navigator.languages;

export const skillHubI18n = i18next.createInstance();
void skillHubI18n.init(i18nOptions(detectedLanguages));

export function formatDateTime(
  value: Date | number,
  locale: SupportedLocale,
) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

/**
 * DEV-15：后端时间字段既有 ISO 字符串也有 unix 秒/毫秒十进制串（Specta
 * 不放行 64 位整数的历史口径）。界面一律经本助手渲染可读本地时间，
 * 不可解析时原样透出（诚实缺省），绝不把裸时间戳交给用户。
 */
export function formatTimestamp(
  value: string | null | undefined,
  locale: SupportedLocale,
): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^\d{13}$/.test(trimmed)) return formatDateTime(Number(trimmed), locale);
  if (/^\d{10}$/.test(trimmed)) return formatDateTime(Number(trimmed) * 1000, locale);
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return formatDateTime(parsed, locale);
  return trimmed;
}

/**
 * DEV-15：把技术标识里的可读尾段解析出来（如
 * `import-conflict:same_name_different_content:find-skills` → `find-skills`），
 * 供历史记录等处以用户可读信息为主展示。
 */
export function readableTailOfId(value: string): string {
  const parts = value.split(":").filter(Boolean);
  return parts[parts.length - 1] || value;
}

export function formatFileSize(bytes: number, locale: SupportedLocale) {
  if (bytes < 1000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "short",
    }).format(bytes);
  }

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "kilobyte",
    unitDisplay: "short",
  }).format(bytes / 1000);
}

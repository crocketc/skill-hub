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

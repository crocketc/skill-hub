import enUS from "./en-US/common.json";
import {
  createSkillHubI18n,
  flattenTranslationKeys,
  formatFileSize,
  resolveLocale,
} from "./index";
import zhCN from "./zh-CN/common.json";

it("ships identical translation key sets for Simplified Chinese and English", () => {
  expect(flattenTranslationKeys(enUS)).toEqual(flattenTranslationKeys(zhCN));
});

it("uses Simplified Chinese only when the system preference requests Chinese", () => {
  expect(resolveLocale(["zh-Hans-CN", "en-US"])).toBe("zh-CN");
  expect(resolveLocale(["fr-FR", "en-GB"])).toBe("en-US");
});

it("uses the first supported language in system preference order", () => {
  expect(resolveLocale(["en-US", "zh-CN"])).toBe("en-US");
  expect(resolveLocale(["fr-FR", "zh-CN", "en-US"])).toBe("zh-CN");
});

it("switches language immediately without mutating the shared resources", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  expect(i18n.t("actions.close")).toBe("Close");

  await i18n.changeLanguage("zh-CN");

  expect(i18n.t("actions.close")).toBe("关闭");
});

it("formats file sizes through Intl for the active locale", () => {
  expect(formatFileSize(1536, "en-US")).toBe("1.5 kB");
  expect(formatFileSize(1536, "zh-CN")).toBe("1.5 kB");
});

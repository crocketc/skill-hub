import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearch";

it("backs every search index entry with a real localized label in both locales", async () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const i18n = await createSkillHubI18n([locale]);
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const label = String(i18n.t(entry.labelKey as never));
      // i18next 在键缺失时回退返回原始 key：那会把技术标识漏进界面。
      expect(label, `${locale}:${entry.id}`).not.toBe(entry.labelKey);
      expect(label, `${locale}:${entry.id}`).not.toMatch(/^settings\./);
    }
  }
});

it("matches every entry through at least one of its own aliases", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const translate = (key: string) => String(i18n.t(key as never));
  const searchableOf = (entry: (typeof SETTINGS_SEARCH_INDEX)[number]) =>
    [translate(entry.labelKey), translate(`settings.sections.${entry.sectionId}`), ...entry.aliases].join(" ");

  for (const entry of SETTINGS_SEARCH_INDEX) {
    const probe = entry.aliases[0] ?? entry.id;
    // 每个条目声明的首个别名必须能检索到该条目，保证索引别名不是死数据。
    const matched = SETTINGS_SEARCH_INDEX.filter((candidate) =>
      probe.split(/\s+/).every((term) => searchableOf(candidate).toLowerCase().includes(term.toLowerCase())),
    );
    expect(
      matched.some((candidate) => candidate.id === entry.id),
      `${entry.id} is reachable via alias "${probe}"`,
    ).toBe(true);
  }
});

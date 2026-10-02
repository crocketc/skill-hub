import type { SettingsSectionId } from "./SettingsSectionNav";

export interface SettingsSearchEntry {
  id: string;
  labelKey: string;
  sectionId: SettingsSectionId;
  aliases: readonly string[];
  targetId?: string;
  href?: string;
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { id: "section-general", labelKey: "settings.sections.general", sectionId: "general", aliases: ["语言", "language", "外观", "appearance", "主题", "theme", "动效", "motion"] },
  { id: "section-interface", labelKey: "settings.sections.interfaceView", sectionId: "interfaceView", aliases: ["视图", "view", "布局", "layout", "列", "columns", "密度", "density", "保存筛选", "saved filters", "快捷抽屉", "quick drawer"] },
  { id: "section-data", labelKey: "settings.sections.dataProtection", sectionId: "dataProtection", aliases: ["备份", "backup", "恢复", "restore", "迁移", "migration", "导出", "export"] },
  { id: "section-network", labelKey: "settings.sections.networkAi", sectionId: "networkAi", aliases: ["网络", "network", "人工智能", "ai", "llm", "模型", "provider", "供应商"] },
  { id: "section-automation", labelKey: "settings.sections.automation", sectionId: "automation", aliases: ["skill 自动检查", "skill auto check", "自动升级", "automatic upgrade", "自动更新", "skill update"] },
  { id: "section-library", labelKey: "settings.sections.libraryMaintenance", sectionId: "libraryMaintenance", aliases: ["扫描", "scan", "健康", "health", "忽略", "ignore", "路径", "path"] },
  { id: "section-update", labelKey: "settings.sections.appUpdate", sectionId: "appUpdate", aliases: ["应用更新", "app update", "启动时检查", "startup update check", "release", "版本检查"] },
  { id: "language", labelKey: "settings.general.language", sectionId: "general", targetId: "settings-language", aliases: ["界面语言", "interface language", "中文", "chinese", "english"] },
  { id: "appearance", labelKey: "settings.general.appearance", sectionId: "general", targetId: "settings-appearance", aliases: ["跟随系统", "system", "浅色", "light", "深色", "dark"] },
  { id: "themes", labelKey: "settings.general.theme", sectionId: "general", targetId: "settings-appearance", aliases: ["主题配色", "theme colors", "九种主题", "nine themes"] },
  { id: "reduced-motion", labelKey: "settings.general.reducedMotion", sectionId: "general", targetId: "settings-reduced-motion", aliases: ["减少动画", "reduce animation", "无动画", "no motion"] },
  { id: "density", labelKey: "settings.view.densityLabel", sectionId: "interfaceView", targetId: "settings-density", aliases: ["紧凑", "compact", "标准", "standard", "宽松", "comfortable"] },
  { id: "skill-views", labelKey: "settings.view.skillViews", sectionId: "interfaceView", aliases: ["技能库视图", "skill library views", "列设置", "column settings", "筛选", "filters"], href: "/library" },
  { id: "project-views", labelKey: "settings.view.projectViews", sectionId: "interfaceView", aliases: ["项目视图", "project views", "项目筛选", "project filters"], href: "/projects" },
  { id: "quick-drawer", labelKey: "settings.view.quickDrawer", sectionId: "interfaceView", aliases: ["快速抽屉", "quick panel", "详情抽屉", "drawer modules"], href: "/library" },
  { id: "backup", labelKey: "settings.backup.heading", sectionId: "dataProtection", targetId: "settings-backup-heading", aliases: ["完整备份", "full backup", "备份位置", "backup location"] },
  { id: "restore-export", labelKey: "settings.search.restoreExport", sectionId: "dataProtection", aliases: ["恢复数据", "restore data", "标准导出", "standard export", "换机", "move device"], href: "/settings/data-protection" },
  { id: "health-check", labelKey: "settings.library.runHealthCheck", sectionId: "libraryMaintenance", targetId: "settings-health-check", aliases: ["技能库扫描", "library scan", "检查技能库", "check library"] },
  { id: "ignore-rule", labelKey: "settings.search.ignorePaths", sectionId: "libraryMaintenance", targetId: "settings-ignore-rule-value", aliases: ["精确路径忽略", "ignore exact path", "忽略路径", "path ignore"] },
  { id: "skill-automation", labelKey: "settings.search.skillAutomation", sectionId: "automation", targetId: "settings-skill-automation", aliases: ["单 Skill 策略", "per skill policy", "全局 Skill 自动检查", "global skill auto check"] },
  { id: "update-check", labelKey: "settings.update.policyEnabled", sectionId: "appUpdate", targetId: "settings-update-policy-enabled", aliases: ["应用自动检查", "app auto check", "更新检查", "update checks"] },
  { id: "startup-check", labelKey: "settings.update.checkOnStartup", sectionId: "appUpdate", targetId: "settings-update-policy-startup", aliases: ["启动时检查应用更新", "check app on startup", "startup update check"] },
  { id: "llm-providers", labelKey: "settings.llm.providersHeading", sectionId: "networkAi", targetId: "settings-panel-networkAi", aliases: ["模型接入", "model access", "凭据", "credentials", "api key"] },
  { id: "ai-capabilities", labelKey: "settings.llm.capabilitiesHeading", sectionId: "networkAi", targetId: "settings-panel-networkAi", aliases: ["ai 安全检查", "ai safety check", "语义重复", "semantic duplicates", "描述翻译", "description translation", "联网搜索", "online search"] },
];

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
}

export function searchSettings(
  query: string,
  translate: (key: string) => string,
): SettingsSearchEntry[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return SETTINGS_SEARCH_INDEX.filter((entry) => {
    const sectionLabel = translate(`settings.sections.${entry.sectionId === "interfaceView" ? "interfaceView" : entry.sectionId}`);
    const searchable = normalize([
      translate(entry.labelKey),
      sectionLabel,
      ...entry.aliases,
    ].join(" "));
    return terms.every((term) => searchable.includes(term));
  });
}

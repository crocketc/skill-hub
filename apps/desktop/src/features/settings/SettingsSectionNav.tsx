import { useTranslation } from "react-i18next";

export type SettingsSectionId =
  | "general"
  | "dataProtection"
  | "networkAi"
  | "automation"
  | "libraryMaintenance"
  | "appUpdate";

export interface SettingsSection {
  id: SettingsSectionId;
  heading: string;
  description: string;
}

export const SECTION_TAB_ID_PREFIX = "settings-tab";
export const SECTION_PANEL_ID_PREFIX = "settings-panel";

export const sectionTabId = (id: SettingsSectionId) => `${SECTION_TAB_ID_PREFIX}-${id}`;
export const sectionPanelId = (id: SettingsSectionId) => `${SECTION_PANEL_ID_PREFIX}-${id}`;

interface SettingsSectionNavProps {
  sections: SettingsSection[];
  activeId: SettingsSectionId;
  onChange: (id: SettingsSectionId) => void;
}

/**
 * 当前分区导航（设计规格 5.1）：宽容器为左侧竖排分区导航，窄容器折叠为
 * 顶部紧凑分区选择器（见 settings.css 的容器查询）。标签页语义 + 方向键
 * 自动激活，键盘与指针共享同一条切换路径。
 */
export function SettingsSectionNav({ sections, activeId, onChange }: SettingsSectionNavProps) {
  const { t } = useTranslation();

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = sections.findIndex((section) => section.id === activeId);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % sections.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + sections.length) % sections.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = sections.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextSection = sections[next];
    onChange(nextSection.id);
    document.getElementById(sectionTabId(nextSection.id))?.focus();
  };

  return (
    <div
      aria-label={t("settings.sectionNavLabel")}
      className="sh-settings-nav"
      onKeyDown={onKeyDown}
      role="tablist"
    >
      {sections.map((section) => (
        <button
          aria-controls={sectionPanelId(section.id)}
          aria-selected={section.id === activeId}
          className="sh-settings-nav__tab"
          id={sectionTabId(section.id)}
          key={section.id}
          onClick={() => onChange(section.id)}
          role="tab"
          tabIndex={section.id === activeId ? 0 : -1}
          type="button"
        >
          {section.heading}
        </button>
      ))}
    </div>
  );
}

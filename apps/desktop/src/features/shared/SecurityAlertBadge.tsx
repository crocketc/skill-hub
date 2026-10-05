import { useTranslation } from "react-i18next";
import type { ProductLevel } from "../../api/bindings";
import { StatusBadge } from "../../ui/StatusBadge";

/**
 * W3-1（FB-003 裁决第 1 节）：安全预警徽标——列表 security_status 列与
 * 详情状态栏共用同一组件、同一事实（security_alert 投影），不各造一套。
 * 徽标只说「预警」并悬浮说明派发被拦；级别只影响 tone，不裸露枚举值。
 */
export function SecurityAlertBadge({ level }: { level: ProductLevel }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={level === "danger" ? "danger" : "warning"}>
      <span title={t("securityAlert.blockedHint")}>
        <svg aria-hidden="true" fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24" width="12">
          <path d="M12 3.5 19 6v5.2c0 4.2-2.7 7.4-7 9.3-4.3-1.9-7-5.1-7-9.3V6z" />
          <path d="M12 8v5.2M12 16.4v.2" />
        </svg>
        {t("securityAlert.badge")}
      </span>
    </StatusBadge>
  );
}

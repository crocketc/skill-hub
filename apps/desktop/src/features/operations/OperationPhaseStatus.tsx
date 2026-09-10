import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { PHASE_PRESENTATION } from "./phasePresentation";
import { type OperationPhase } from "./api";

/**
 * 操作阶段状态徽标（T4-A 4.2 契约：状态必须图标＋文字，不单靠颜色）。
 * 操作记录页、恢复页与单条操作详情共用同一映射。
 */
export function OperationPhaseStatus({ phase }: { phase: OperationPhase }) {
  const { t } = useTranslation();
  const presentation = PHASE_PRESENTATION[phase];
  return (
    <span className={`sh-status sh-status--${phase} sh-phase-status`}>
      <Icon aria-hidden="true" name={presentation.icon} />
      {t(`operations.phases.${phase}` as never)}
    </span>
  );
}

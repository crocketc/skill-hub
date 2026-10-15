import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import { formatTimestamp } from "../../i18n";
import { desktopDirectoryOpener, type DirectoryOpener } from "../../platform/directoryOpener";
import { Button } from "../../ui/Button";
import type { SkillDetailFacade, SkillDetailSummary, SkillInsightCombinationFact } from "./api";

// W3-7：概览生命周期与组合接真实事实——生命周期/复核日期读 summary，
// 保存复核日期与转常规走 setTrial 命令（成功后由调用方失效 summary 查询）；
// 组合行展示 insights 组合事实并链接组合管理页。DEV 场景按钮与样例保存
// 文案移除。
export function ReviewOverviewStatus({ combinations, facade, onSummarySaved, skillId, summary }: {
  combinations?: SkillInsightCombinationFact[];
  facade: SkillDetailFacade;
  onSummarySaved?: () => void;
  skillId: string;
  summary: SkillDetailSummary;
}) {
  const { i18n, t } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  const isTrial = summary.lifecycle === "trial";
  const trialDue = summary.trialDue ?? "";
  const [trialDateDraft, setTrialDateDraft] = useState("");
  const [trialOpen, setTrialOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const memberships = combinations ?? [];
  const openTrialDialog = (draft: string) => {
    setTrialDateDraft(draft);
    setSaveError(undefined);
    setTrialOpen(true);
  };
  const saveTrial = async (due: string | null) => {
    if (saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await facade.setTrial(skillId, due);
      setTrialOpen(false);
      onSummarySaved?.();
    } catch (error) {
      setSaveError(describeNativeError(error, (key, options) => String(t(key as never, options as never)), "skillDetail.trialSaveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <dl className="sh-skill-detail-review__profile-strip">
        <div><dt>{t("skillDetail.review.overview.lifecycle")}</dt><dd>{t(isTrial ? "skillDetail.review.overview.trial" : "skillDetail.review.overview.regular")}</dd></div>
        {isTrial ? (
          <div><dt>{t("skillDetail.review.overview.reviewDate")}</dt><dd>{trialDue ? formatTimestamp(trialDue, locale) : t("skillDetail.review.overview.unset")}<Button onClick={() => openTrialDialog(trialDue)} size="sm" variant="ghost">{t("skillDetail.review.overview.adjustDate")}</Button></dd></div>
        ) : (
          <div><dt>{t("skillDetail.review.overview.trialReview")}</dt><dd><span>{t("skillDetail.review.overview.unset")}</span><Button onClick={() => openTrialDialog("")} size="sm" variant="ghost">{t("skillDetail.review.overview.setDate")}</Button></dd></div>
        )}
        <div><dt>{t("skillDetail.review.overview.combination")}</dt><dd><span>{memberships.length ? memberships.map((combination) => combination.name).join("、") : t("skillDetail.review.overview.noCombination")}</span><Link to="/library/combinations">{t("skillDetail.review.overview.manageCombinations")}</Link></dd></div>
      </dl>

      <Dialog.Root open={trialOpen} onOpenChange={setTrialOpen}>
        <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
          <Dialog.Title>{t("skillDetail.review.overview.dialogTitle")}</Dialog.Title>
          <Dialog.Description>{t("skillDetail.review.overview.dialogDescription")}</Dialog.Description>
          <label className="sh-skill-detail-review__dialog-field">{t("skillDetail.review.overview.date")}<input aria-label={t("skillDetail.review.overview.date")} onChange={(event) => setTrialDateDraft(event.currentTarget.value)} type="date" value={trialDateDraft} /></label>
          {saveError ? <p role="alert">{saveError}</p> : null}
          <div className="sh-dialog__actions">
            <Button onClick={() => setTrialOpen(false)} size="sm" variant="ghost">{t("actions.cancel")}</Button>
            <Button disabled={saving || !trialDateDraft} onClick={() => void saveTrial(trialDateDraft)} size="sm" variant="secondary">{t("skillDetail.review.overview.saveDate")}</Button>
            {isTrial ? <Button disabled={saving} onClick={() => void saveTrial(null)} size="sm">{t("skillDetail.review.overview.makeRegular")}</Button> : null}
          </div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

// W3-6：主体位置展示 K9 真实物化根路径（summary.rootPath）；「打开位置」走
// 受控 open_local_directory 命令，「复制路径」走剪贴板；不再渲染样例路径与
// 弹层。根未物化时如实呈现空态，不渲染任何操作按钮。
export function ReviewSubjectLocation({ directoryOpener = desktopDirectoryOpener, rootPath }: {
  directoryOpener?: DirectoryOpener;
  rootPath?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [openError, setOpenError] = useState(false);
  const [opening, setOpening] = useState(false);
  const openLocation = async () => {
    if (!rootPath || opening) return;
    setOpenError(false);
    setOpening(true);
    try {
      await directoryOpener.openDirectory(rootPath);
    } catch {
      setOpenError(true);
    } finally {
      setOpening(false);
    }
  };
  if (!rootPath) {
    return (
      <div className="sh-skill-detail-review__context-row">
        <div><span>{t("skillDetail.review.subjectLocation.label")}</span><p>{t("skillDetail.review.subjectLocation.unknown")}</p></div>
      </div>
    );
  }
  return (
    <div className="sh-skill-detail-review__context-row">
      <div>
        <span>{t("skillDetail.review.subjectLocation.label")}</span>
        <strong><code title={rootPath}>{rootPath}</code></strong>
        <Button disabled={opening} onClick={() => void openLocation()} size="sm" variant="ghost">{t("skillDetail.review.subjectLocation.open")}</Button>
        <Button onClick={() => {
          setCopied(false); setCopyError(undefined);
          void (async () => {
            try {
              if (!navigator.clipboard) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(rootPath);
              setCopied(true);
            } catch { setCopyError(t("skillDetail.review.subjectLocation.copyError")); }
          })();
        }} size="sm" variant="secondary">{t("skillDetail.review.subjectLocation.copy")}</Button>
      </div>
      {copied ? <p role="status">{t("skillDetail.review.subjectLocation.copied")}</p> : null}
      {copyError ? <p role="alert">{copyError}</p> : null}
      {openError ? <p role="alert">{t("skillDetail.review.subjectLocation.openError")}</p> : null}
    </div>
  );
}

export function ReviewHeaderActions({ onCentralize, onDispatch, onExport, onDelete, onReclaim, onRenameRuntimeName }: {
  /**
   * §7.8 生产承载：转为集中管理保留一次确认入口，承载与治理页共用的真实
   * 批次契约（候选行/确认绑定/影响预览都来自治理门面）；无待接管关系时不
   * 传该回调，入口隐藏。演示确认弹层与前端状态机已移除。
   */
  onCentralize?: () => void;
  /** 派发接真实部署流程（§10）：跳转部署对话框路由，演示弹层已移除。 */
  onDispatch: () => void;
  /** 导出接标准导出（W3-2）：跳转数据保护页并携带本 Skill，复用同一条导出流。 */
  onExport: () => void;
  /** 删除接统一确认（W3-2/K2 两段式）：触发详情页既有的删除影响确认流程。 */
  onDelete: () => void;
  /** T05：回收技能的全部可用去向，进入统一使用关系释放流程。 */
  onReclaim?: () => void;
  /** T15：显式修改技能主体运行名，提交前预览全部受管目标。 */
  onRenameRuntimeName?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {onCentralize ? (
        <Button className="sh-skill-detail-review__warning-action" onClick={onCentralize} size="sm" variant="ghost">{t("skillDetail.review.header.centralize")}</Button>
      ) : null}
      {onReclaim ? (
        <Button onClick={onReclaim} size="sm" variant="secondary">{t("skillDetail.actions.reclaim")}</Button>
      ) : null}
      {onRenameRuntimeName ? (
        <Button onClick={onRenameRuntimeName} size="sm" variant="secondary">{t("skillDetail.runtimeRename.button")}</Button>
      ) : null}
      <Button onClick={onDispatch} size="sm">{t("skillDetail.review.header.dispatch")}</Button>
      <Button onClick={onExport} size="sm" variant="secondary">{t("skillDetail.review.header.export")}</Button>
      <Button onClick={onDelete} size="sm" variant="danger">{t("skillDetail.review.header.delete")}</Button>
    </>
  );
}

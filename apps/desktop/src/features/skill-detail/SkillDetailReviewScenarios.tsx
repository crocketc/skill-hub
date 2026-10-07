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
        <div><dt>生命周期</dt><dd>{isTrial ? "试用中" : "常规"}</dd></div>
        {isTrial ? (
          <div><dt>复核日期</dt><dd>{trialDue ? formatTimestamp(trialDue, locale) : "尚未设定"}<Button onClick={() => openTrialDialog(trialDue)} size="sm" variant="ghost">调整复核日期</Button></dd></div>
        ) : (
          <div><dt>试用复核</dt><dd><span>尚未设定</span><Button onClick={() => openTrialDialog("")} size="sm" variant="ghost">设置复核日期</Button></dd></div>
        )}
        <div><dt>组合</dt><dd><span>{memberships.length ? memberships.map((combination) => combination.name).join("、") : "未加入组合"}</span><Link to="/library/combinations">管理组合</Link></dd></div>
      </dl>

      <Dialog.Root open={trialOpen} onOpenChange={setTrialOpen}>
        <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
          <Dialog.Title>试用复核设置</Dialog.Title>
          <Dialog.Description>到期只提醒复核，不会自动删除技能或回收使用位置。</Dialog.Description>
          <label className="sh-skill-detail-review__dialog-field">复核日期<input aria-label="复核日期" onChange={(event) => setTrialDateDraft(event.currentTarget.value)} type="date" value={trialDateDraft} /></label>
          {saveError ? <p role="alert">{saveError}</p> : null}
          <div className="sh-dialog__actions">
            <Button onClick={() => setTrialOpen(false)} size="sm" variant="ghost">取消</Button>
            <Button disabled={saving || !trialDateDraft} onClick={() => void saveTrial(trialDateDraft)} size="sm" variant="secondary">保存复核日期</Button>
            {isTrial ? <Button disabled={saving} onClick={() => void saveTrial(null)} size="sm">转为常规</Button> : null}
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
        <div><span>技能库主体位置</span><p>主体目录未物化或未知。</p></div>
      </div>
    );
  }
  return (
    <div className="sh-skill-detail-review__context-row">
      <div>
        <span>技能库主体位置</span>
        <strong><code title={rootPath}>{rootPath}</code></strong>
        <Button disabled={opening} onClick={() => void openLocation()} size="sm" variant="ghost">打开位置</Button>
        <Button onClick={() => {
          setCopied(false); setCopyError(undefined);
          void (async () => {
            try {
              if (!navigator.clipboard) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(rootPath);
              setCopied(true);
            } catch { setCopyError("无法复制路径。请允许剪贴板访问，或选中上方完整路径后手动复制。"); }
          })();
        }} size="sm" variant="secondary">复制路径</Button>
      </div>
      {copied ? <p role="status">路径已复制。</p> : null}
      {copyError ? <p role="alert">{copyError}</p> : null}
      {openError ? <p role="alert">无法打开主体目录。</p> : null}
    </div>
  );
}

export function ReviewHeaderActions({ onCentralize, onDispatch, onExport, onDelete }: {
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
}) {
  return (
    <>
      {onCentralize ? (
        <Button className="sh-skill-detail-review__warning-action" onClick={onCentralize} size="sm" variant="ghost">转为集中管理</Button>
      ) : null}
      <Button onClick={onDispatch} size="sm">派发</Button>
      <Button onClick={onExport} size="sm" variant="secondary">导出</Button>
      <Button onClick={onDelete} size="sm" variant="danger">删除</Button>
    </>
  );
}

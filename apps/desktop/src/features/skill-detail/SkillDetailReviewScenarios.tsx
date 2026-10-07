import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTimestamp } from "../../i18n";
import { Button } from "../../ui/Button";
import type { SkillDetailSummary } from "./api";

export function ReviewOverviewStatus({ summary }: { summary: SkillDetailSummary }) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  const [isTrial, setIsTrial] = useState(summary.lifecycle === "trial");
  const [trialDue, setTrialDue] = useState(summary.trialDue ?? "");
  const [trialDateDraft, setTrialDateDraft] = useState(summary.trialDue ?? "");
  const [trialOpen, setTrialOpen] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const [memberships, setMemberships] = useState<string[]>([]);
  const [comboDraft, setComboDraft] = useState<string[]>([]);
  const [comboSaved, setComboSaved] = useState(false);

  return (
    <>
      <dl className="sh-skill-detail-review__profile-strip">
        <div><dt>生命周期</dt><dd>{isTrial ? "试用中" : "常规"}</dd></div>
        {isTrial ? (
          <div><dt>复核日期</dt><dd>{trialDue ? formatTimestamp(trialDue, locale) : "尚未设定"}<Button onClick={() => { setTrialDateDraft(trialDue); setTrialOpen(true); }} size="sm" variant="ghost">调整复核日期</Button></dd></div>
        ) : null}
        {!isTrial ? <div><dt>试用复核</dt><dd><span>尚未设定</span><Button onClick={() => { setTrialDateDraft(""); setTrialOpen(true); }} size="sm" variant="ghost">设置复核日期</Button></dd></div> : null}
        <div><dt>组合</dt><dd><span>{memberships.length ? memberships.join("、") : "未加入组合"}</span><Button onClick={() => { setComboDraft(memberships); setComboSaved(false); setComboOpen(true); }} size="sm" variant="ghost">管理组合</Button></dd></div>
      </dl>
      {comboSaved ? <p className="sh-skill-detail-review__inline-status" role="status">组合成员变更已保存到当前原型示例。</p> : null}
      <details className="sh-skill-detail-review__dev-scenarios">
        <summary>DEV 场景演示</summary>
        <div>
          <Button onClick={() => { setIsTrial(true); setTrialDue("2026-10-17"); }} size="sm" variant="ghost">切换到试用复核场景</Button>
          <Button onClick={() => { setIsTrial(false); setTrialDue(""); }} size="sm" variant="ghost">切回常规生命周期</Button>
        </div>
      </details>

      <Dialog.Root open={trialOpen} onOpenChange={setTrialOpen}>
        <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
          <Dialog.Title>试用复核设置</Dialog.Title>
          <Dialog.Description>到期只提醒复核，不会自动删除技能或回收使用位置。</Dialog.Description>
          <label className="sh-skill-detail-review__dialog-field">复核日期<input aria-label="复核日期" onChange={(event) => setTrialDateDraft(event.currentTarget.value)} type="date" value={trialDateDraft} /></label>
          <div className="sh-dialog__actions">
            <Button onClick={() => setTrialOpen(false)} size="sm" variant="ghost">取消</Button>
            <Button disabled={!trialDateDraft} onClick={() => { setTrialDue(trialDateDraft); setIsTrial(true); setTrialOpen(false); }} size="sm" variant="secondary">保存复核日期</Button>
            {isTrial ? <Button onClick={() => { setIsTrial(false); setTrialDue(""); setTrialOpen(false); }} size="sm">转为常规</Button> : null}
          </div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={comboOpen} onOpenChange={setComboOpen}>
        <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
          <Dialog.Title>管理组合成员</Dialog.Title>
          <Dialog.Description>选择希望一起配合的组合。只保存成员关系，不复制 Skill 内容。</Dialog.Description>
          <fieldset className="sh-skill-detail-review__choice-list"><legend>可加入的组合</legend>
            {["文档处理组合", "资料转换组合"].map((name) => (
              <label key={name}><input checked={comboDraft.includes(name)} onChange={() => setComboDraft((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name])} type="checkbox" />{name}</label>
            ))}
          </fieldset>
          <div className="sh-dialog__actions">
            <Button onClick={() => setComboOpen(false)} size="sm" variant="ghost">取消</Button>
            <Button onClick={() => { setMemberships(comboDraft); setComboSaved(true); setComboOpen(false); }} size="sm">保存成员变更</Button>
          </div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function ReviewSubjectLocation() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const path = "~/SkillHub/skills/pdf-reader";
  return (
    <>
      <div className="sh-skill-detail-review__context-row">
        <div><span>技能库主体位置</span><strong><code>{path}</code></strong><Button onClick={() => { setOpen(true); setCopied(false); }} size="sm" variant="ghost">打开位置</Button></div>
      </div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
          <Dialog.Title>技能库主体位置</Dialog.Title><Dialog.Description>这是技能库中的主体目录示例，不代表 Agent 或项目使用位置。</Dialog.Description>
          <code className="sh-skill-detail-review__long-value">{path}</code>
          {copied ? <p role="status">路径已复制。</p> : null}
          {copyError ? <p role="alert">{copyError}</p> : null}
          <div className="sh-dialog__actions"><Button onClick={() => {
            setCopied(false); setCopyError(undefined);
            void (async () => {
              try {
                if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                await navigator.clipboard.writeText(path);
                setCopied(true);
              } catch { setCopyError("无法复制路径。请允许剪贴板访问，或选中上方完整路径后手动复制。"); }
            })();
          }} size="sm" variant="secondary">复制路径</Button><Button onClick={() => setOpen(false)} size="sm">返回技能详情</Button></div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </>
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

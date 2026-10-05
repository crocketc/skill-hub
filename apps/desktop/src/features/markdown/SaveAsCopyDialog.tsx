import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useInRouterContext, useNavigate } from "react-router-dom";
import { nativeErrorCode } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
import { Icon } from "../../ui/Icon";
import { RadioField } from "../../ui/RadioField";
import {
  type SaveAsCopyOutcome,
  type SaveAsCopyReplacementPreview,
  type SaveAsCopyReplacementTargetPreview,
  type SaveMarkdownAsCopy,
} from "../../api/bindings";
import type { SaveAsCopyFacade } from "./api";

/**
 * K5/MS-06：另存副本统一对话框——保存流程中的「另存为新 Skill」语义收口。
 *
 * 用户显式选择继承分支：
 * - 不继承（默认）：原主体的关系与部署原样保留；
 * - 替换继承：先 get_save_as_copy_replacement_preview 取得三件套预览
 *   （preview_id/expires_at/指纹），逐目标如实分列事实，共享物理目标
 *   必须逐项显式确认（复用 K2/G-09 共享目标确认门语义，缺省绝不接管），
 *   blocker 目标按不可核验呈现且不得进入提交。
 *
 * 预览过期或后端指纹/漂移拒绝（operation.conflict）→ 撤下提交入口，
 * 唯一出路是重新预览（K3 同款语义）；其余拒绝不消费预览，允许补齐确认
 * 后用同一 preview_id 重试。回执 saved_skill_copy 后定位新主体并按
 * Replaced/PartiallyReplaced/NotRequested 三态如实呈现，绝不把局部成功
 * 说成全部完成。
 */
export interface SaveAsCopyDialogProps {
  expectedIdentity: string;
  facade: SaveAsCopyFacade;
  markdown: string;
  /** 提交前持久化本机草稿（防抖窗口内的输入不丢）；失败阻断提交。 */
  onBeforeSave?: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  /** 回执 saved_skill_copy 后回调（工作区据以失效缓存）。 */
  onSaved: (outcome: SaveAsCopyOutcome) => void;
  open: boolean;
  path: string;
  skillId: string;
  /** 来源版本身份；未知时缺省=不登记血缘（保留旧行为），绝不伪造。 */
  sourceVersionId?: string | null;
}

type SaveAsCopyStep = "choose" | "review" | "result";

const DEPLOYED_STATES = new Set(["deployed"]);

/** 已知目标结果错误码的可读映射；未知码回退为含原始码的诚实文案。 */
const targetResultErrorKeys: Record<string, string> = {
  "deployment.target_changed": "markdown.saveCopy.targetError.target_changed",
  "deployment.target_exists": "markdown.saveCopy.targetError.target_exists",
  "deployment.ownership_mismatch": "markdown.saveCopy.targetError.ownership_mismatch",
  "target.ownership_unknown": "markdown.saveCopy.targetError.ownership_unknown",
};

export function SaveAsCopyDialog({
  expectedIdentity,
  facade,
  markdown,
  onBeforeSave,
  onOpenChange,
  onSaved,
  open,
  path,
  skillId,
  sourceVersionId,
}: SaveAsCopyDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<SaveAsCopyStep>("choose");
  const [inheritance, setInheritance] = useState<"none" | "replace">("none");
  // null=沿用默认选择（替换预览：全部活动部署；提交集：全部可核验目标）。
  const [targetSelection, setTargetSelection] = useState<Set<string> | null>(null);
  const [includedTargets, setIncludedTargets] = useState<Set<string> | null>(null);
  const [sharedConfirmed, setSharedConfirmed] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SaveAsCopyReplacementPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [drifted, setDrifted] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SaveAsCopyOutcome | null>(null);
  const [saving, setSaving] = useState(false);

  // 对话框每次打开都回到选择步：上一次的预览与确认不跨会话复用。
  useEffect(() => {
    if (open) {
      setStep("choose");
      setInheritance("none");
      setTargetSelection(null);
      setIncludedTargets(null);
      setSharedConfirmed(new Set());
      setPreview(null);
      setPreviewBusy(false);
      setPreviewFailed(false);
      setDrifted(false);
      setSaveFailed(false);
      setSaveErrorCode(null);
      setOutcome(null);
      setSaving(false);
    }
  }, [open]);

  const targetsQuery = useQuery({
    enabled: open && inheritance === "replace",
    queryFn: () => facade.listDeployments(skillId),
    queryKey: ["markdown-save-copy", "targets", skillId],
    retry: false,
  });
  const activeTargets = (targetsQuery.data ?? []).filter((deployment) =>
    DEPLOYED_STATES.has(deployment.state),
  );
  const selectedTargets = targetSelection
    ?? new Set(activeTargets.map((deployment) => deployment.id));

  // 预览过期与 K3 导出同口径：expires_at 已过即撤下提交入口，唯一出路是
  // 重新预览，绝不静默重试注定失败的提交。
  const previewExpired = preview !== null && Date.parse(preview.expires_at) <= Date.now();
  const previewTargets = preview?.targets ?? [];
  const included = includedTargets
    ?? new Set(
      previewTargets
        .filter((target) => target.blocker === null)
        .map((target) => target.deployment_id),
    );
  const sharedConfirmationsMissing = previewTargets.some(
    (target) =>
      included.has(target.deployment_id)
      && target.requires_shared_target_confirmation
      && !sharedConfirmed.has(target.deployment_id),
  );
  const replaceSubmissionReady = included.size > 0 && !sharedConfirmationsMissing;
  // 「不继承」分支从选样步直接提交；「替换继承」必须在预览步持有有效预览。
  const submitReady = !previewExpired && !drifted
    && (inheritance === "none"
      || (step === "review" && preview !== null && replaceSubmissionReady));

  const requestPreview = async () => {
    setPreviewBusy(true);
    setPreviewFailed(false);
    try {
      const result = await facade.saveAsCopyReplacementPreview(skillId, [...selectedTargets]);
      setPreview(result);
      setIncludedTargets(null);
      setSharedConfirmed(new Set());
      setDrifted(false);
      setSaveFailed(false);
      setSaveErrorCode(null);
      setStep("review");
    } catch {
      setPreviewFailed(true);
    } finally {
      setPreviewBusy(false);
    }
  };

  const backToTargets = () => {
    setPreview(null);
    setIncludedTargets(null);
    setSharedConfirmed(new Set());
    setDrifted(false);
    setSaveFailed(false);
    setSaveErrorCode(null);
    setStep("choose");
  };

  const submitSaveAsCopy = async () => {
    if (!submitReady) {
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    setSaveErrorCode(null);
    try {
      await onBeforeSave?.();
    } catch {
      // 草稿持久化失败：阻断提交并留在对话框，本机输入不丢。
      setSaveFailed(true);
      setSaving(false);
      return;
    }
    const request: SaveMarkdownAsCopy = {
      expected_identity: expectedIdentity,
      inheritance:
        inheritance === "replace" && preview
          ? {
              ReplaceTargets: {
                preview_id: preview.preview_id,
                targets: [...included].map((deploymentId) => ({
                  confirm_shared_target_removal: sharedConfirmed.has(deploymentId),
                  deployment_id: deploymentId,
                })),
              },
            }
          : "None",
      markdown,
      path,
      skill_id: skillId,
    };
    if (sourceVersionId) {
      request.origin = {
        source_skill_id: skillId,
        source_version_id: sourceVersionId,
      };
    }
    try {
      const result = await facade.saveMarkdownAsCopy(request);
      setOutcome(result);
      setStep("result");
      // 保存成功即失效技能库列表缓存，新主体立即可见；详情页由导航后的
      // 查询自行取新数据。
      await queryClient.invalidateQueries({ queryKey: ["skill-library"] });
      onSaved(result);
    } catch (error) {
      const code = nativeErrorCode(error);
      if (code === "operation.conflict") {
        // 指纹/漂移拒绝：旧预览整体作废，撤下提交入口并引导重新预览。
        setDrifted(true);
      } else {
        // 其余拒绝未消费预览：保留同一 preview_id，允许补齐确认后重试。
        setSaveFailed(true);
        setSaveErrorCode(code);
      }
    } finally {
      setSaving(false);
    }
  };

  // 导航交给路由内的链接组件承载（见 OpenNewSkillAction/RecoveryLink）；
  // 这里只负责关闭对话框，由链接统一完成“定位新主体”。
  const closeResult = () => {
    if (!outcome) {
      return;
    }
    onOpenChange(false);
  };

  if (!open) {
    return null;
  }

  const close = () => onOpenChange(false);
  const submitLabel = saveErrorCode
    ? t("markdown.saveCopy.retrySamePreview")
    : t("markdown.saveCopy.submit");

  return (
    <Dialog.Root
      // 编辑器工作台内的对话框保持非模态：用户在选择继承分支时仍可对照
      // 编辑器中的原文（同 SkillQuickDrawer 的非模态先例）。
      modal={false}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open={open}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="sh-dialog__overlay" />
        <Dialog.Content
          aria-label={step === "result"
            ? t("markdown.saveCopy.resultTitle")
            : t("markdown.saveCopy.title")}
          aria-describedby={undefined}
          className="sh-dialog sh-dialog__content sh-save-copy__dialog"
          onEscapeKeyDown={(event) => {
            if (saving) {
              event.preventDefault();
            }
          }}
        >
          <Dialog.Title className="sh-dialog__title">
            {step === "result"
              ? t("markdown.saveCopy.resultTitle")
              : t("markdown.saveCopy.title")}
          </Dialog.Title>
          <Dialog.Description className="sh-dialog__description">
            {t("markdown.saveCopy.description")}
          </Dialog.Description>

          {step === "choose" ? (
            <>
              <fieldset className="sh-save-copy__fieldset">
                <legend>{t("markdown.saveCopy.modeLegend")}</legend>
                <RadioField
                  checked={inheritance === "none"}
                  description={t("markdown.saveCopy.modeNoneHint")}
                  label={t("markdown.saveCopy.modeNone")}
                  name="save-copy-inheritance"
                  onChange={() => setInheritance("none")}
                  value="none"
                />
                <RadioField
                  checked={inheritance === "replace"}
                  description={t("markdown.saveCopy.modeReplaceHint")}
                  label={t("markdown.saveCopy.modeReplace")}
                  name="save-copy-inheritance"
                  onChange={() => setInheritance("replace")}
                  value="replace"
                />
              </fieldset>
              {inheritance === "replace" ? (
                <fieldset className="sh-save-copy__fieldset">
                  <legend>{t("markdown.saveCopy.targetsLegend")}</legend>
                  {targetsQuery.isPending ? (
                    <p role="status">{t("markdown.saveCopy.targetsLoading")}</p>
                  ) : targetsQuery.isError ? (
                    <p role="alert">{t("markdown.saveCopy.targetsUnavailable")}</p>
                  ) : activeTargets.length === 0 ? (
                    <p role="status">{t("markdown.saveCopy.noTargets")}</p>
                  ) : (
                    activeTargets.map((deployment) => (
                      <CheckboxField
                        checked={selectedTargets.has(deployment.id)}
                        key={deployment.id}
                        label={`${deployment.runtime_name} · ${deployment.id}`}
                        onChange={(event) => {
                          const next = new Set(selectedTargets);
                          if (event.target.checked) {
                            next.add(deployment.id);
                          } else {
                            next.delete(deployment.id);
                          }
                          setTargetSelection(next);
                        }}
                      />
                    ))
                  )}
                  {previewFailed ? (
                    <p className="sh-save-copy__notice" role="alert">
                      {t("markdown.saveCopy.previewFailed")}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              {saveFailed ? (
                // 「不继承」分支的提交在选样步发生，失败说明必须同样落在这里。
                <p className="sh-save-copy__notice" role="alert">
                  {saveErrorCode
                    ? t("markdown.saveCopy.previewRejectedRetryable", { code: saveErrorCode })
                    : t("markdown.saveCopy.saveFailed")}
                </p>
              ) : null}
              <div className="sh-dialog__actions">
                <Button onClick={close} size="sm" variant="ghost">
                  {t("actions.cancel")}
                </Button>
                {inheritance === "replace" ? (
                  <Button
                    disabled={previewBusy || selectedTargets.size === 0}
                    loading={previewBusy}
                    onClick={() => void requestPreview()}
                    size="sm"
                  >
                    {t("markdown.saveCopy.previewAction")}
                  </Button>
                ) : (
                  <Button
                    loading={saving}
                    onClick={() => void submitSaveAsCopy()}
                    size="sm"
                  >
                    {submitLabel}
                  </Button>
                )}
              </div>
            </>
          ) : null}

          {step === "review" && preview ? (
            <>
              {previewExpired ? (
                <p className="sh-save-copy__notice" role="alert">
                  {t("markdown.saveCopy.previewExpired")}
                </p>
              ) : null}
              {drifted ? (
                <p className="sh-save-copy__notice" role="alert">
                  {t("markdown.saveCopy.previewDrift")}
                </p>
              ) : null}
              {saveFailed && saveErrorCode ? (
                <p className="sh-save-copy__notice" role="alert">
                  {t("markdown.saveCopy.previewRejectedRetryable", { code: saveErrorCode })}
                </p>
              ) : null}
              {saveFailed && !saveErrorCode ? (
                <p className="sh-save-copy__notice" role="alert">
                  {t("markdown.saveCopy.saveFailed")}
                </p>
              ) : null}
              <ul className="sh-save-copy__targets" data-testid="copy-target-list">
                {previewTargets.map((target) => (
                  <TargetPreviewRow
                    included={included.has(target.deployment_id)}
                    key={target.deployment_id}
                    onIncludedChange={(next) => {
                      const nextIncluded = new Set(included);
                      if (next) {
                        nextIncluded.add(target.deployment_id);
                      } else {
                        nextIncluded.delete(target.deployment_id);
                      }
                      setIncludedTargets(nextIncluded);
                    }}
                    onSharedConfirmChange={(confirmed) => {
                      const next = new Set(sharedConfirmed);
                      if (confirmed) {
                        next.add(target.deployment_id);
                      } else {
                        next.delete(target.deployment_id);
                      }
                      setSharedConfirmed(next);
                    }}
                    sharedConfirmed={sharedConfirmed.has(target.deployment_id)}
                    target={target}
                  />
                ))}
              </ul>
              <div className="sh-dialog__actions">
                <Button
                  disabled={saving}
                  onClick={backToTargets}
                  size="sm"
                  variant="ghost"
                >
                  {t("markdown.saveCopy.rePreview")}
                </Button>
                {!previewExpired && !drifted ? (
                  <Button
                    disabled={!submitReady}
                    loading={saving}
                    onClick={() => void submitSaveAsCopy()}
                    size="sm"
                  >
                    {submitLabel}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          {step === "result" && outcome ? (
            <>
              <p className="sh-save-copy__lead">{t("markdown.saveCopy.resultLead", { name: outcome.display_name })}</p>
              <p>{outcome.lineage_registered
                ? t("markdown.saveCopy.lineageRegistered")
                : t("markdown.saveCopy.lineageMissing")}</p>
              <SaveAsCopyInheritanceOutcomeView outcome={outcome.inheritance} />
              {outcome.recovery_operation_id ? (
                <RecoveryLink
                  label={t("markdown.saveCopy.recoveryLink")}
                  operationId={outcome.recovery_operation_id}
                />
              ) : null}
              <div className="sh-dialog__actions">
                <Button onClick={close} size="sm" variant="ghost">
                  {t("markdown.saveCopy.close")}
                </Button>
                <OpenNewSkillAction
                  label={t("markdown.saveCopy.openNewSkill")}
                  onActivate={closeResult}
                  skillId={outcome.skill_id}
                />
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * 「打开新 Skill」：按钮语义 + 路由内导航；无路由上下文的嵌入场景
 * （部分测试宿主）降级为仅关闭动作，不伪造导航。
 */
function OpenNewSkillAction({
  label,
  onActivate,
  skillId,
}: {
  label: string;
  onActivate: () => void;
  skillId: string;
}) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return (
      <Button onClick={onActivate} size="sm">
        {label}
      </Button>
    );
  }
  return <OpenNewSkillNavigateButton label={label} onActivate={onActivate} skillId={skillId} />;
}

function OpenNewSkillNavigateButton({
  label,
  onActivate,
  skillId,
}: {
  label: string;
  onActivate: () => void;
  skillId: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      onClick={() => {
        onActivate();
        navigate(`/library/${skillId}`);
      }}
      size="sm"
    >
      {label}
    </Button>
  );
}

/** 恢复入口深链；无路由上下文时不渲染，绝不渲染死链接。 */
function RecoveryLink({ label, operationId }: { label: string; operationId: string }) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return null;
  }
  return (
    <p>
      <Link to={`/recovery?operationId=${encodeURIComponent(operationId)}`}>
        {label}
      </Link>
    </p>
  );
}

function TargetPreviewRow({
  included,
  onIncludedChange,
  onSharedConfirmChange,
  sharedConfirmed,
  target,
}: {
  included: boolean;
  onIncludedChange: (included: boolean) => void;
  onSharedConfirmChange: (confirmed: boolean) => void;
  sharedConfirmed: boolean;
  target: SaveAsCopyReplacementTargetPreview;
}) {
  const { t } = useTranslation();
  const blocked = target.blocker !== null;
  return (
    <li data-testid={`copy-target-${target.deployment_id}`}>
      <div className="sh-save-copy__target-facts">
        <CheckboxField
          ariaLabel={target.path}
          checked={included && !blocked}
          disabled={blocked}
          label={target.path}
          onChange={(event) => onIncludedChange(event.target.checked)}
        />
        <ul className="sh-save-copy__fact-list">
          <li>{t("markdown.saveCopy.targetRuntime", { name: target.runtime_name })}</li>
          <li>{target.managed
            ? t("markdown.saveCopy.targetManaged")
            : t("markdown.saveCopy.targetUnmanaged")}</li>
          <li data-testid={`copy-target-consumers-${target.deployment_id}`}>
            {t("markdown.saveCopy.consumers", { consumers: target.consumer_deployment_ids.length })}
          </li>
          <li>
            {blocked
              ? null
              : <span>{t("markdown.saveCopy.versionLabel")} <code>{target.version_id}</code></span>}
          </li>
        </ul>
        {blocked ? (
          <p className="sh-save-copy__blocker" role="note">
            <Icon className="sh-markdown-status__icon" name="failure" size={14} />
            {/* K4 同款机器码映射：已知 blocker 给专属文案，未知码诚实回退并带原始码。 */}
            {(() => {
              const key = `markdown.saveCopy.blocker.${target.blocker}`;
              const translated = String(t(key as never));
              return translated !== key
                ? translated
                : t("markdown.saveCopy.blocker.unknown", { code: target.blocker });
            })()}
          </p>
        ) : null}
        {!blocked && target.requires_shared_target_confirmation ? (
          <CheckboxField
            ariaLabel={`${t("markdown.saveCopy.sharedConfirmLabel")} ${target.path}`}
            checked={sharedConfirmed}
            label={t("markdown.saveCopy.sharedConfirmLabel")}
            onChange={(event) => onSharedConfirmChange(event.target.checked)}
          />
        ) : null}
      </div>
    </li>
  );
}

function SaveAsCopyInheritanceOutcomeView({ outcome }: { outcome: SaveAsCopyOutcome["inheritance"] }) {
  const { t } = useTranslation();
  if (outcome === "NotRequested") {
    return <p role="status">{t("markdown.saveCopy.outcomeNotRequested")}</p>;
  }
  // 绑定把另一分支生成为 `?: never` 的交叉形式；用值守卫收窄到真实分支。
  const replaced = "Replaced" in outcome ? outcome.Replaced : undefined;
  if (replaced) {
    return <p role="status">{t("markdown.saveCopy.outcomeReplaced", { count: replaced.items.length })}</p>;
  }
  const partial = "PartiallyReplaced" in outcome ? outcome.PartiallyReplaced : undefined;
  if (!partial) {
    return null;
  }
  return (
    <div role="status">
      <p>{t("markdown.saveCopy.outcomePartial")}</p>
      <ul className="sh-save-copy__result-list">
        {partial.items.map((item) => (
          <li data-testid={`copy-result-${item.deployment_id}`} key={item.deployment_id}>
            <span>{item.path}</span>
            {item.status === "applied" ? (
              <span className="sh-save-copy__result-applied">{t("markdown.saveCopy.resultApplied")}</span>
            ) : (
              <span className="sh-save-copy__result-failed">
                {t("markdown.saveCopy.resultFailed")}
                {": "}
                {(() => {
                  const reasonKey = item.error_code
                    ? targetResultErrorKeys[item.error_code]
                    : undefined;
                  return reasonKey
                    ? t(reasonKey as never)
                    : t("markdown.saveCopy.targetError.unknown", { code: item.error_code ?? "" });
                })()}
                {/* 失败项始终携带稳定错误码，供工单与恢复对账。 */}
                {item.error_code ? <code> {item.error_code}</code> : null}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

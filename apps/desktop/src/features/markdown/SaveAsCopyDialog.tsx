import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useInRouterContext, useNavigate } from "react-router-dom";
import { describeNativeError, nativeErrorCode } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
import { Icon } from "../../ui/Icon";
import { RadioField } from "../../ui/RadioField";
import {
  type CommitUsageChange,
  type DerivedRenamePreview,
  type EnvironmentProblemView,
  type PrepareUsageChange,
  type PreparedUsageChange,
  type SaveAsCopyOutcome,
  type SaveAsCopyReplacementPreview,
  type SaveAsCopyReplacementTargetPreview,
  type SaveMarkdownAsCopy,
  type UsageChangeResult,
} from "../../api/bindings";
import { Input } from "../../ui/Input";
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

export interface DerivedRenameDialogProps {
  problem: EnvironmentProblemView;
  previewFacade: Pick<SaveAsCopyFacade, "saveAsCopyReplacementPreview">;
  getCurrentSkillVersion: (skillId: string) => Promise<string | null>;
  onPrepare: (request: PrepareUsageChange) => Promise<PreparedUsageChange>;
  onCommit: (request: CommitUsageChange) => Promise<UsageChangeResult>;
  onCompleted: () => Promise<void> | void;
  onClose: () => void;
  open: boolean;
}

type DerivedRenameTargetChoice = {
  relationId: string;
  deploymentId: string;
  path: string;
};

type DerivedRenameSourceChoice = {
  skillId: string;
  runtimeName: string;
  targets: DerivedRenameTargetChoice[];
};

function managedDeploymentId(relationId: string): string | null {
  const prefix = "managed:";
  return relationId.startsWith(prefix) && relationId.length > prefix.length
    ? relationId.slice(prefix.length)
    : null;
}

function fullEntryPath(directoryPath: string | null | undefined, relativePath: string): string {
  if (!directoryPath) return relativePath;
  const separator = directoryPath.includes("\\") ? "\\" : "/";
  return `${directoryPath.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/^[\\/]+/, "")}`;
}

function derivedRenameSources(problem: EnvironmentProblemView): DerivedRenameSourceChoice[] {
  const bySkill = new Map<string, DerivedRenameSourceChoice>();
  for (const entry of problem.entries) {
    if (!entry.skill_id) continue;
    const targetChoices = entry.relation_ids.flatMap((relationId) => {
      const deploymentId = managedDeploymentId(relationId);
      return deploymentId
        ? [{ relationId, deploymentId, path: fullEntryPath(entry.directory_path, entry.relative_entry_path) }]
        : [];
    });
    if (targetChoices.length === 0) continue;
    const existing = bySkill.get(entry.skill_id) ?? {
      skillId: entry.skill_id,
      runtimeName: entry.runtime_name ?? "",
      targets: [],
    };
    const knownRelations = new Set(existing.targets.map((target) => target.relationId));
    existing.targets.push(...targetChoices.filter((target) => !knownRelations.has(target.relationId)));
    bySkill.set(entry.skill_id, existing);
  }
  return [...bySkill.values()].map((source) => ({
    ...source,
    targets: source.targets.sort((left, right) => left.path.localeCompare(right.path)),
  }));
}

function newDerivedRenameOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `derived-rename-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 重名问题里的局部处理：先选主体、运行名和受管目标，核实替换预览与
 * 共享消费者，再取统一关系准备快照；只有显式确认准确路径后才提交。
 */
export function DerivedRenameDialog({
  problem,
  previewFacade,
  getCurrentSkillVersion,
  onPrepare,
  onCommit,
  onCompleted,
  onClose,
  open,
}: DerivedRenameDialogProps) {
  const { t } = useTranslation();
  const sources = useMemo(() => derivedRenameSources(problem), [problem]);
  const [sourceSkillId, setSourceSkillId] = useState(sources[0]?.skillId ?? "");
  const [runtimeName, setRuntimeName] = useState("");
  const [selectedRelationIds, setSelectedRelationIds] = useState<Set<string>>(() => new Set());
  const [confirmedSharedRelationIds, setConfirmedSharedRelationIds] = useState<Set<string>>(() => new Set());
  const [preflight, setPreflight] = useState<SaveAsCopyReplacementPreview | null>(null);
  const [prepared, setPrepared] = useState<PreparedUsageChange | null>(null);
  const [result, setResult] = useState<UsageChangeResult | null>(null);
  const [confirmedImpact, setConfirmedImpact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescanFailed, setRescanFailed] = useState(false);
  const [previewClock, setPreviewClock] = useState(() => Date.now());
  const translate = (key: string, options?: Record<string, unknown>) =>
    String(t(key as never, options as never));
  const describeError = (reason: unknown) => describeNativeError(
    reason,
    (key, options) => String(t(key as never, options as never)),
    "tasks.notices.failureUnknown",
  );
  const source = sources.find((candidate) => candidate.skillId === sourceSkillId);
  const versionQuery = useQuery({
    enabled: open && Boolean(source),
    queryFn: () => getCurrentSkillVersion(source!.skillId),
    queryKey: ["relationship-derived-rename", "current-version", sourceSkillId],
    retry: false,
  });
  const currentVersion = versionQuery.data ?? null;
  const selectedTargets = source?.targets.filter((target) => selectedRelationIds.has(target.relationId)) ?? [];
  const preflightByDeployment = new Map((preflight?.targets ?? []).map((target) => [target.deployment_id, target]));
  const unverifiedTargets = selectedTargets.filter((target) => {
    const previewTarget = preflightByDeployment.get(target.deploymentId);
    return !previewTarget || !previewTarget.managed || previewTarget.blocker !== null;
  });
  const sharedTargets = selectedTargets.filter((target) =>
    preflightByDeployment.get(target.deploymentId)?.requires_shared_target_confirmation,
  );
  const missingSharedConfirmations = sharedTargets.filter((target) =>
    !confirmedSharedRelationIds.has(target.relationId),
  );
  const previewExpiry = preflight ? Date.parse(preflight.expires_at) : Number.NaN;
  const previewExpired = preflight !== null
    && (!Number.isFinite(previewExpiry) || previewExpiry <= previewClock);
  const derivedPreview: DerivedRenamePreview | null = prepared?.derived_rename ?? null;
  const derivedTargets = derivedPreview?.targets ?? [];
  const derivedTargetsBlock = derivedTargets.some((target) => target.blocker !== null);
  const preparedTargetIds = new Set(derivedTargets.map((target) => target.relation_id));
  const preparedScopeMatches = selectedTargets.length > 0
    && selectedTargets.every((target) => preparedTargetIds.has(target.relationId))
    && derivedTargets.length === selectedTargets.length;

  useEffect(() => {
    if (!open) return;
    setRuntimeName("");
    setSelectedRelationIds(new Set());
    setConfirmedSharedRelationIds(new Set());
    setPreflight(null);
    setPrepared(null);
    setResult(null);
    setConfirmedImpact(false);
    setBusy(false);
    setError(null);
    setRescanFailed(false);
  }, [open, problem.problem_id]);

  useEffect(() => {
    setSourceSkillId((current) => sources.some((candidate) => candidate.skillId === current)
      ? current
      : sources[0]?.skillId ?? "");
  }, [sources]);

  useEffect(() => {
    if (!preflight || !Number.isFinite(previewExpiry)) return;
    const delay = Math.max(0, previewExpiry - Date.now());
    const timer = window.setTimeout(() => setPreviewClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [preflight, previewExpiry]);

  useEffect(() => {
    setSelectedRelationIds(new Set());
    setConfirmedSharedRelationIds(new Set());
    setPreflight(null);
    setPrepared(null);
    setResult(null);
    setConfirmedImpact(false);
    setError(null);
  }, [sourceSkillId]);

  const invalidateDraft = () => {
    setPreflight(null);
    setPrepared(null);
    setConfirmedSharedRelationIds(new Set());
    setConfirmedImpact(false);
    setError(null);
  };

  const requestReplacementPreview = async () => {
    if (!source || !currentVersion || !runtimeName.trim() || selectedTargets.length === 0) return;
    setBusy(true);
    setError(null);
    invalidateDraft();
    setPreviewClock(Date.now());
    try {
      const next = await previewFacade.saveAsCopyReplacementPreview(
        source.skillId,
        selectedTargets.map((target) => target.deploymentId),
      );
      const requestedIds = new Set(selectedTargets.map((target) => target.deploymentId));
      if (next.source_skill_id !== source.skillId
        || next.source_version_id !== currentVersion
        || next.targets.length !== requestedIds.size
        || next.targets.some((target) => !requestedIds.has(target.deployment_id))) {
        throw new Error(translate("markdown.saveCopy.derivedRename.previewUnavailable"));
      }
      setPreflight(next);
    } catch (reason) {
      setError(reason instanceof Error
        && reason.message === translate("markdown.saveCopy.derivedRename.previewUnavailable")
        ? reason.message
        : describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const prepareDerivedRename = async () => {
    if (!source || !currentVersion || !preflight || previewExpired
      || selectedTargets.length === 0 || unverifiedTargets.length > 0
      || missingSharedConfirmations.length > 0 || !runtimeName.trim()) return;
    setBusy(true);
    setError(null);
    setConfirmedImpact(false);
    try {
      const relationIds = selectedTargets.map((target) => target.relationId);
      const next = await onPrepare({
        operation_id: newDerivedRenameOperationId(),
        action: "derive_and_replace",
        relation_ids: [],
        problem_id: problem.problem_id,
        skill_id: source.skillId,
        requested_form: null,
        copy_disposition: null,
        content_basis: null,
        retain_entry_key: null,
        selected_entry_keys: [],
        runtime_name: runtimeName.trim(),
        base_version_id: currentVersion,
        selected_relation_ids: relationIds,
        confirmed_shared_relation_ids: relationIds.filter((relationId) =>
          confirmedSharedRelationIds.has(relationId),
        ),
        non_recognized_destination: null,
      });
      const preview = next.derived_rename;
      if (!preview
        || preview.source_skill_id !== source.skillId
        || preview.base_version_id !== currentVersion
        || preview.runtime_name !== runtimeName.trim()
        || preview.selected_relation_ids.length !== relationIds.length
        || relationIds.some((relationId) => !preview.selected_relation_ids.includes(relationId))) {
        throw new Error(translate("markdown.saveCopy.derivedRename.previewUnavailable"));
      }
      setPrepared(next);
    } catch (reason) {
      setError(reason instanceof Error
        && reason.message === translate("markdown.saveCopy.derivedRename.previewUnavailable")
        ? reason.message
        : describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const commitDerivedRename = async () => {
    if (!prepared || !derivedPreview || !preparedScopeMatches || derivedTargetsBlock || !confirmedImpact) return;
    setBusy(true);
    setError(null);
    try {
      const next = await onCommit({
        operation_id: prepared.operation_id,
        prepared_id: prepared.prepared_id,
      });
      setResult(next);
      try {
        await onCompleted();
      } catch {
        setRescanFailed(true);
      }
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog.Root
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      open={open}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="sh-dialog__overlay" />
        <Dialog.Content
          aria-label={result
            ? translate("markdown.saveCopy.derivedRename.resultTitle")
            : translate("markdown.saveCopy.derivedRename.title")}
          aria-describedby={undefined}
          className="sh-dialog sh-dialog__content sh-save-copy__dialog"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <Dialog.Title className="sh-dialog__title">
            {result
              ? translate("markdown.saveCopy.derivedRename.resultTitle")
              : translate("markdown.saveCopy.derivedRename.title")}
          </Dialog.Title>
          {!result ? (
            <Dialog.Description className="sh-dialog__description">
              {translate("markdown.saveCopy.derivedRename.description")}
            </Dialog.Description>
          ) : null}

          {result ? (
            <DerivedRenameResultView
              prepared={derivedPreview}
              rescanFailed={rescanFailed}
              result={result}
              onClose={close}
            />
          ) : (
            <>
              {sources.length > 1 ? (
                <label className="sh-save-copy__fieldset">
                  <span>{translate("markdown.saveCopy.derivedRename.sourceLabel")}</span>
                  <select
                    aria-label={translate("markdown.saveCopy.derivedRename.sourceLabel")}
                    disabled={busy || preflight !== null}
                    onChange={(event) => setSourceSkillId(event.target.value)}
                    value={sourceSkillId}
                  >
                    {sources.map((candidate) => (
                      <option key={candidate.skillId} value={candidate.skillId}>
                        {candidate.runtimeName || translate("markdown.saveCopy.derivedRename.unnamedSource")}
                      </option>
                    ))}
                  </select>
                </label>
              ) : source ? (
                <p className="sh-save-copy__lead">
                  {translate("markdown.saveCopy.derivedRename.source", {
                    name: source.runtimeName || translate("markdown.saveCopy.derivedRename.unnamedSource"),
                  })}
                </p>
              ) : (
                <p role="alert">{translate("markdown.saveCopy.derivedRename.noManagedSource")}</p>
              )}

              <label className="sh-save-copy__fieldset">
                <span>{translate("markdown.saveCopy.derivedRename.runtimeNameLabel")}</span>
                <Input
                  aria-label={translate("markdown.saveCopy.derivedRename.runtimeNameLabel")}
                  autoComplete="off"
                  disabled={busy || preflight !== null}
                  onChange={(event) => {
                    invalidateDraft();
                    setRuntimeName(event.target.value);
                  }}
                  value={runtimeName}
                />
              </label>

              <fieldset className="sh-save-copy__fieldset">
                <legend>{translate("markdown.saveCopy.derivedRename.targetsLegend")}</legend>
                {source && versionQuery.isPending ? (
                  <p role="status">{translate("markdown.saveCopy.derivedRename.versionLoading")}</p>
                ) : source && (versionQuery.isError || !currentVersion) ? (
                  <p role="alert">{translate("markdown.saveCopy.derivedRename.versionUnavailable")}</p>
                ) : null}
                {source?.targets.map((target) => (
                  <CheckboxField
                    checked={selectedRelationIds.has(target.relationId)}
                    disabled={busy || preflight !== null}
                    key={target.relationId}
                    label={target.path}
                    onChange={(event) => {
                      const next = new Set(selectedRelationIds);
                      if (event.target.checked) next.add(target.relationId);
                      else next.delete(target.relationId);
                      setSelectedRelationIds(next);
                      invalidateDraft();
                    }}
                  />
                ))}
                {source?.targets.length === 0 ? (
                  <p role="status">{translate("markdown.saveCopy.derivedRename.noManagedTargets")}</p>
                ) : null}
              </fieldset>

              {preflight ? (
                <div className="sh-save-copy__derived-preview" data-testid="derived-rename-preview">
                  <h3>{translate("markdown.saveCopy.derivedRename.previewHeading")}</h3>
                  {previewExpired ? (
                    <p className="sh-save-copy__notice" role="alert">
                      {translate("markdown.saveCopy.derivedRename.previewExpired")}
                    </p>
                  ) : null}
                  <ul className="sh-save-copy__targets">
                    {selectedTargets.map((target) => {
                      const previewTarget = preflightByDeployment.get(target.deploymentId);
                      return (
                        <li key={target.relationId}>
                          <div className="sh-save-copy__target-facts">
                            <code title={target.path}>{target.path}</code>
                            {previewTarget?.blocker || !previewTarget?.managed ? (
                              <p className="sh-save-copy__blocker" role="alert">
                                {translate("markdown.saveCopy.derivedRename.targetUnavailable")}
                              </p>
                            ) : null}
                            {previewTarget?.requires_shared_target_confirmation ? (
                              <CheckboxField
                                checked={confirmedSharedRelationIds.has(target.relationId)}
                                disabled={busy || previewExpired}
                                label={translate("markdown.saveCopy.derivedRename.sharedConfirm", {
                                  path: target.path,
                                  count: previewTarget.consumer_deployment_ids.length,
                                })}
                                onChange={(event) => {
                                  const next = new Set(confirmedSharedRelationIds);
                                  if (event.target.checked) next.add(target.relationId);
                                  else next.delete(target.relationId);
                                  setConfirmedSharedRelationIds(next);
                                }}
                              />
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {prepared && derivedPreview ? (
                    <>
                      <h3>{translate("markdown.saveCopy.derivedRename.exactPreviewHeading")}</h3>
                      {preparedScopeMatches ? (
                        <ul className="sh-save-copy__targets">
                          {derivedTargets.map((target) => (
                            <li className="sh-save-copy__target-facts" key={target.relation_id}>
                              <code title={target.previous_path}>{target.previous_path}</code>
                              <span aria-hidden="true">→</span>
                              <code title={target.replacement_path}>{target.replacement_path}</code>
                              {target.blocker ? (
                                <p className="sh-save-copy__blocker" role="alert">
                                  {translate("markdown.saveCopy.derivedRename.targetBlocked")}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p role="alert">{translate("markdown.saveCopy.derivedRename.scopeChanged")}</p>
                      )}
                      <p>{translate("markdown.saveCopy.derivedRename.impactSummary", {
                        name: derivedPreview.runtime_name,
                        count: derivedPreview.targets.length,
                      })}</p>
                      <p>{translate("markdown.saveCopy.derivedRename.lineageNotice")}</p>
                      <CheckboxField
                        checked={confirmedImpact}
                        disabled={busy || !preparedScopeMatches || derivedTargetsBlock}
                        label={translate("markdown.saveCopy.derivedRename.confirmImpact")}
                        onChange={(event) => setConfirmedImpact(event.target.checked)}
                      />
                    </>
                  ) : null}
                </div>
              ) : null}

              {error ? <p className="sh-save-copy__notice" role="alert">{error}</p> : null}
              <div className="sh-dialog__actions">
                <Button disabled={busy} onClick={close} size="sm" variant="ghost">
                  {translate("actions.cancel")}
                </Button>
                {result ? null : prepared ? (
                  <Button
                    disabled={busy || !confirmedImpact || !preparedScopeMatches || derivedTargetsBlock}
                    loading={busy}
                    onClick={() => void commitDerivedRename()}
                    size="sm"
                  >
                    {translate("markdown.saveCopy.derivedRename.confirmAction")}
                  </Button>
                ) : preflight && previewExpired ? (
                  <Button
                    disabled={busy || !runtimeName.trim() || selectedTargets.length === 0}
                    loading={busy}
                    onClick={() => void requestReplacementPreview()}
                    size="sm"
                  >
                    {translate("markdown.saveCopy.derivedRename.rePreviewAction")}
                  </Button>
                ) : preflight ? (
                  <Button
                    disabled={busy || previewExpired || selectedTargets.length === 0
                      || unverifiedTargets.length > 0 || missingSharedConfirmations.length > 0}
                    loading={busy}
                    onClick={() => void prepareDerivedRename()}
                    size="sm"
                  >
                    {translate("markdown.saveCopy.derivedRename.prepareAction")}
                  </Button>
                ) : (
                  <Button
                    disabled={busy || versionQuery.isPending || !currentVersion
                      || !runtimeName.trim() || selectedTargets.length === 0}
                    loading={busy}
                    onClick={() => void requestReplacementPreview()}
                    size="sm"
                  >
                    {translate("markdown.saveCopy.derivedRename.previewAction")}
                  </Button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DerivedRenameResultView({
  prepared,
  result,
  rescanFailed,
  onClose,
}: {
  prepared: DerivedRenamePreview | null;
  result: UsageChangeResult;
  rescanFailed: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const translate = (key: string) => String(t(key as never));
  const itemResults = prepared?.targets.map((target) => ({
    target,
    result: result.item_results.find((item) => item.relation_ids.includes(target.relation_id)) ?? null,
  })) ?? [];
  const complete = itemResults.length > 0
    && itemResults.every(({ result: item }) => item?.status === "applied")
    && !result.recovery_required;
  const newSkill = result.derived_skill_id ?? null;
  return (
    <>
      <p role="status">{translate(complete
        ? "markdown.saveCopy.derivedRename.completed"
        : "markdown.saveCopy.derivedRename.partial")}</p>
      {itemResults.length > 0 ? (
        <ul className="sh-save-copy__result-list">
          {itemResults.map(({ target, result: item }) => (
            <li key={target.relation_id}>
              <code title={target.replacement_path}>{target.replacement_path}</code>
              <span className={item?.status === "applied"
                ? "sh-save-copy__result-applied"
                : "sh-save-copy__result-failed"}>
                {translate(item?.status === "applied"
                  ? "markdown.saveCopy.derivedRename.applied"
                  : item?.status === "recovery_required"
                    ? "markdown.saveCopy.derivedRename.recoveryRequired"
                    : item?.status === "failed"
                      ? "markdown.saveCopy.derivedRename.failed"
                      : "markdown.saveCopy.derivedRename.resultMissing")}
              </span>
              {item?.reason && targetResultErrorKeys[item.reason] ? (
                <span>{translate(targetResultErrorKeys[item.reason])}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {rescanFailed ? (
        <p role="alert">{translate("markdown.saveCopy.derivedRename.rescanFailed")}</p>
      ) : (
        <p>{translate("markdown.saveCopy.derivedRename.rescanned")}</p>
      )}
      {newSkill ? (
        <OpenNewSkillAction
          label={translate("markdown.saveCopy.derivedRename.openSkill")}
          onActivate={onClose}
          skillId={newSkill}
        />
      ) : null}
      {result.recovery_operation_id ? (
        <RecoveryLink
          label={translate("markdown.saveCopy.derivedRename.recoveryLink")}
          operationId={result.recovery_operation_id}
        />
      ) : null}
      <div className="sh-dialog__actions">
        <Button onClick={onClose} size="sm" variant="secondary">
          {translate("markdown.saveCopy.close")}
        </Button>
      </div>
    </>
  );
}

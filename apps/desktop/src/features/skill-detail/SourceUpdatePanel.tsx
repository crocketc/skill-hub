import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppliedSourceUpdate,
  SourceUpdateFileChange,
  SourceUpdatePreview,
  SourceUpdateStatus,
  UpdateDecision,
  UpstreamCheckResult,
} from "../../api/bindings";
import { describeNativeError, nativeErrorParams } from "../../api/nativeErrors";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { skillDetailKeys } from "./api";

export interface SourceUpdateFacade {
  checkSourceUpdate: (skillId: string) => Promise<UpstreamCheckResult>;
  /** K6：采纳入口先取得候选预览，确认后经 commitSourceUpdate 消耗。 */
  prepareSourceUpdate: (skillId: string) => Promise<SourceUpdatePreview>;
  commitSourceUpdate: (
    previewId: string,
    decision: UpdateDecision,
  ) => Promise<AppliedSourceUpdate>;
  /** K6/D3：按候选身份忽略；关闭界面不发本命令。 */
  ignoreSourceUpdate: (skillId: string, candidateIdentity: string) => Promise<void>;
  /** K6：持久化检查/忽略状态；从未检查过时 state 为 null。 */
  getSourceUpdateStatus: (skillId: string) => Promise<SourceUpdateStatus>;
}

interface SourceUpdatePanelProps {
  facade: SourceUpdateFacade;
  skillId: string;
  /** 统一执行桥的在途投影；测试可注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
}

type PanelState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "preparing" }
  | { phase: "result"; result: UpstreamCheckResult }
  | { phase: "preview"; preview: SourceUpdatePreview; error?: string }
  | { phase: "committing"; preview: SourceUpdatePreview }
  | { phase: "applied"; applied: AppliedSourceUpdate }
  /** 预览已被后端结算（过期/漂移/事实变化）：提交入口撤下，唯一出路重新预览。 */
  | { phase: "stale" }
  | { phase: "error"; message: string }
  /** Prepare 被后端以“已最新”拒绝：如实呈现状态，不当失败渲染。 */
  | { phase: "upToDate" };

/** 后端 K6 裁定的预览结算原因：一旦返回，旧预览不可再提交。 */
const SETTLED_PREVIEW_REASONS = new Set([
  "source_update_preview_expired",
  "source_update_preview_drifted",
  "source_update_preview_facts_changed",
]);

function nativeReason(error: unknown): string | undefined {
  const reason = nativeErrorParams(error).reason;
  return typeof reason === "string" ? reason : undefined;
}

/** 与 nativeApi.getVersions 同口径：哈希只以截短形态进入界面。 */
function shortIdentity(identity: string): string {
  if (identity.startsWith("sha256:")) {
    return `sha256:${identity.slice("sha256:".length, "sha256:".length + 8)}…`;
  }
  return identity.slice(0, 18);
}

function groupFiles(files: SourceUpdateFileChange[]) {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const file of files) {
    if (file.change === "added") added.push(file.path);
    else if (file.change === "removed") removed.push(file.path);
    else modified.push(file.path);
  }
  return { added, removed, modified };
}

/**
 * FE-11 / K6 来源更新：检查→预览→确认的预览绑定流。
 * 采纳入口只此一条（prepare→commit）；决定（采用/保留本地/取消）都通过
 * 预览 id 提交；忽略当前候选是唯一持久化的“放下”方式，关闭界面不发命令。
 * 每个状态都如实呈现，不把"无法检查"伪装成"已最新"。
 */
export function SourceUpdatePanel({ facade, skillId, tracker = operationTracker }: SourceUpdatePanelProps) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const queryClient = useQueryClient();
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  // K6：读取持久化的检查/忽略状态（只读查询；失败只降级提示，不影响检查）。
  const statusQuery = useQuery({
    queryFn: () => facade.getSourceUpdateStatus(skillId),
    queryKey: skillDetailKeys.sourceUpdateStatus(skillId),
  });
  // describeNativeError 以动态键调用翻译；i18next 的强类型键联合在此收窄。
  const describe = (error: unknown) =>
    describeNativeError(
      error,
      (key, options) => String(t(key as never, options as never)),
      "skillDetail.sourceUpdate.failedGeneric",
    );

  const refreshStatus = () => {
    void queryClient.invalidateQueries({
      queryKey: skillDetailKeys.sourceUpdateStatus(skillId),
    });
  };

  const check = async () => {
    setState({ phase: "checking" });
    try {
      const result = await facade.checkSourceUpdate(skillId);
      setState({ phase: "result", result });
      // 检查会改写持久化的候选事实（checked_at/candidate_identity）。
      refreshStatus();
    } catch (error) {
      setState({ phase: "error", message: describe(error) });
    }
  };

  const prepare = async () => {
    setState({ phase: "preparing" });
    try {
      const preview = await facade.prepareSourceUpdate(skillId);
      setState({ phase: "preview", preview });
    } catch (error) {
      // 已最新不是失败状态：如实呈现，不渲染错误。
      if (nativeReason(error) === "source_up_to_date") {
        setState({ phase: "upToDate" });
        return;
      }
      setState({ phase: "error", message: describe(error) });
    }
  };

  const decide = async (preview: SourceUpdatePreview, decision: UpdateDecision) => {
    setState({ phase: "committing", preview });
    try {
      // 统一执行反馈（任务 4）：应用上游更新是长流程（可能重写受管副本），
      // 因此占用在途顶栏而不是走 instant。
      const applied = await runTrackedOperation({
        targetHref: `/library/${encodeURIComponent(skillId)}#versions`,
        kind: "apply_source_update",
        label: t("skillDetail.tracker.applyUpdateLabel"),
        notifications,
        tracker,
        translate: (key, options) => String(t(key as never, options as never)),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("skillDetail.tracker.applyUpdateFailed"),
          detail: message,
        }),
        describeError: describe,
        // MS-07：采纳成功后版本列表、概要与洞察都必须刷新；其余决定只
        // 影响来源检查状态投影。
        queryClient,
        invalidateQueryKeys:
          decision === "take_upstream"
            ? [
                skillDetailKeys.versions(skillId),
                skillDetailKeys.summary(skillId),
                skillDetailKeys.insights(skillId),
                skillDetailKeys.sourceUpdateStatus(skillId),
              ]
            : [skillDetailKeys.sourceUpdateStatus(skillId)],
        run: () => facade.commitSourceUpdate(preview.preview_id, decision),
      });
      setState({ phase: "applied", applied });
    } catch (error) {
      // 预览已被结算：提交入口撤下，唯一出路重新预览（K2/K3/K5 同口径）。
      if (SETTLED_PREVIEW_REASONS.has(nativeReason(error) ?? "")) {
        setState({ phase: "stale" });
        return;
      }
      // 其余拒绝预览保留：同一个 preview_id 可直接重试。
      setState({ phase: "preview", preview, error: describe(error) });
    }
  };

  const ignore = async (candidateIdentity: string) => {
    try {
      // 忽略是一次幂等写入：走 instant 模式，只给结果反馈。
      await runTrackedOperation({
        kind: "ignore_source_update",
        label: t("skillDetail.sourceUpdate.ignore"),
        mode: "instant",
        notifications,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({
          tone: "success",
          title: t("skillDetail.sourceUpdate.ignored"),
        }),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("skillDetail.sourceUpdate.ignoreFailed"),
          detail: message,
        }),
        describeError: describe,
        queryClient,
        invalidateQueryKeys: [skillDetailKeys.sourceUpdateStatus(skillId)],
        run: () => facade.ignoreSourceUpdate(skillId, candidateIdentity),
      });
    } catch {
      // 通知与在途桥已如实呈现失败；面板内不重复渲染错误块。
    }
  };

  const busy = state.phase === "checking" || state.phase === "preparing" || state.phase === "committing";
  const status = statusQuery.data;
  const inResult = state.phase === "result" || state.phase === "preparing";
  const resultPayload = state.phase === "result" ? state.result : null;

  return (
    <section aria-label={t("skillDetail.sourceUpdate.ariaLabel")} className="sh-source-update">
      <div className="sh-source-update__row">
        <Button disabled={busy} onClick={() => void check()} variant="secondary">
          {state.phase === "checking"
            ? t("skillDetail.sourceUpdate.checking")
            : state.phase === "idle"
              ? t("skillDetail.sourceUpdate.check")
              : t("skillDetail.sourceUpdate.recheck")}
        </Button>
      </div>

      {/* 持久化状态提示只在没有具体检查结果时呈现（结果视图自带上下文版本）。 */}
      {!statusQuery.isError && status?.candidate_ignored && !inResult ? (
        <p role="note">{t("skillDetail.sourceUpdate.statusIgnored")}</p>
      ) : null}
      {!statusQuery.isError
        && status
        && !status.candidate_ignored
        && (status.state === "update_available" || status.state === "update_available_with_local_changes")
        && state.phase === "idle" ? (
          <p role="note">
            {t("skillDetail.sourceUpdate.statusSeen", {
              upstream: status.upstream_label ?? t("skillDetail.versions.upstreamPending"),
            })}
          </p>
        ) : null}

      {state.phase === "error" ? <p role="alert">{t("skillDetail.sourceUpdate.failed", { error: state.message })}</p> : null}
      {state.phase === "upToDate" ? <p role="status">{t("skillDetail.sourceUpdate.upToDate")}</p> : null}

      {inResult ? (
        <ResultView
          ignoredCandidate={Boolean(
            status?.candidate_ignored
              && (status.candidate_identity == null
                || status.candidate_identity === resultPayload?.candidate_identity),
          )}
          preparing={state.phase === "preparing"}
          result={resultPayload}
          onIgnore={(identity) => void ignore(identity)}
          onPrepare={() => void prepare()}
        />
      ) : null}

      {state.phase === "preview" || state.phase === "committing" ? (
        <PreviewView
          committing={state.phase === "committing"}
          error={state.phase === "preview" ? state.error : undefined}
          preview={state.preview}
          onDecide={(decision) => void decide(state.preview, decision)}
        />
      ) : null}

      {state.phase === "stale" ? (
        <div>
          <p role="alert">{t("skillDetail.sourceUpdate.previewInvalidated")}</p>
          <div className="sh-source-update__actions">
            <Button onClick={() => void prepare()} variant="primary">
              {t("skillDetail.sourceUpdate.reprepare")}
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === "applied" ? <AppliedResult applied={state.applied} /> : null}
    </section>
  );
}

function AppliedResult({ applied }: { applied: AppliedSourceUpdate }) {
  const { t } = useTranslation();
  let summary: string;
  if (applied.decision === "take_upstream" && applied.new_version) {
    summary = t("skillDetail.sourceUpdate.appliedUpstream", { version: applied.new_version });
  } else if (applied.decision === "keep_local") {
    summary = t("skillDetail.sourceUpdate.keptLocal");
  } else if (applied.decision === "cancel") {
    summary = t("skillDetail.sourceUpdate.appliedCancelled");
  } else {
    summary = t("skillDetail.sourceUpdate.appliedGeneric");
  }
  return (
    <div>
      <p role="status">{summary}</p>
      {applied.deployments_need_reconciliation ? (
        <p role="status">{t("skillDetail.sourceUpdate.reconcile")}</p>
      ) : null}
    </div>
  );
}

function ResultView({
  result,
  preparing,
  ignoredCandidate,
  onPrepare,
  onIgnore,
}: {
  /** preparing 期间保留结果视图但禁用入口，避免闪烁回空闲。 */
  result: UpstreamCheckResult | null;
  preparing: boolean;
  ignoredCandidate: boolean;
  onPrepare: () => void;
  onIgnore: (candidateIdentity: string) => void;
}) {
  const { t } = useTranslation();
  const resolved: UpstreamCheckResult | null = result;
  if (!resolved) {
    return <p role="status">{t("skillDetail.sourceUpdate.preparing")}</p>;
  }

  if (resolved.state === "up_to_date") {
    return <p role="status">{t("skillDetail.sourceUpdate.upToDate")}</p>;
  }
  if (resolved.state === "source_unavailable") {
    return <p role="status">{t("skillDetail.sourceUpdate.unavailable")}</p>;
  }
  if (resolved.state === "authentication_required") {
    return <p role="status">{t("skillDetail.sourceUpdate.authRequired")}</p>;
  }
  if (resolved.state === "no_upstream") {
    return <p role="status">{t("skillDetail.sourceUpdate.noUpstream")}</p>;
  }

  const withLocalChanges = resolved.state === "update_available_with_local_changes";
  const upstreamLabel = resolved.upstream_label ?? "";
  const candidateIdentity = resolved.candidate_identity ?? null;
  return (
    <div>
      <p role="status">
        {withLocalChanges
          ? t("skillDetail.sourceUpdate.availableWithChanges", {
              local: resolved.local_version ?? "—",
              upstream: upstreamLabel || resolved.upstream_version || "—",
            })
          : t("skillDetail.sourceUpdate.available", {
              local: resolved.local_version ?? "—",
              upstream: upstreamLabel || resolved.upstream_version || "—",
            })}
      </p>
      {ignoredCandidate ? (
        <p role="note">{t("skillDetail.sourceUpdate.statusIgnored")}</p>
      ) : null}
      <div className="sh-source-update__actions">
        {withLocalChanges ? (
          <p role="note">{t("skillDetail.sourceUpdate.takeUpstreamBlocked")}</p>
        ) : (
          <Button disabled={preparing} onClick={onPrepare} variant="primary">
            {t("skillDetail.sourceUpdate.takeUpstream")}
          </Button>
        )}
      </div>
      {/* 次要操作位：忽略不与主决定并列，且只对有稳定身份的候选提供。 */}
      {candidateIdentity && !ignoredCandidate ? (
        <div className="sh-source-update__secondary">
          <Button
            disabled={preparing}
            onClick={() => onIgnore(candidateIdentity)}
            size="sm"
            variant="ghost"
          >
            {t("skillDetail.sourceUpdate.ignore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PreviewView({
  preview,
  committing,
  error,
  onDecide,
}: {
  preview: SourceUpdatePreview;
  committing: boolean;
  error?: string;
  onDecide: (decision: UpdateDecision) => void;
}) {
  const { t } = useTranslation();
  const groups = groupFiles(preview.files);
  const expiresAt = new Date(preview.expires_at);
  const expiresLabel = Number.isNaN(expiresAt.getTime())
    ? preview.expires_at
    : expiresAt.toLocaleString();
  const fileGroups: Array<{ key: "added" | "removed" | "modified"; labelKey: string; paths: string[] }> = [
    { key: "added", labelKey: "skillDetail.sourceUpdate.filesAdded", paths: groups.added },
    { key: "removed", labelKey: "skillDetail.sourceUpdate.filesRemoved", paths: groups.removed },
    { key: "modified", labelKey: "skillDetail.sourceUpdate.filesModified", paths: groups.modified },
  ];
  return (
    <div className="sh-source-update__preview">
      <h4>{t("skillDetail.sourceUpdate.previewHeading")}</h4>
      <p role="status">
        {preview.upstream_label
          ? t("skillDetail.sourceUpdate.previewIntro", {
              label: preview.upstream_label,
              expires: expiresLabel,
            })
          : t("skillDetail.sourceUpdate.previewIntroUnlabeled", { expires: expiresLabel })}
      </p>
      <p className="sh-source-update__meta" title={preview.candidate_identity}>
        {t("skillDetail.sourceUpdate.candidateIdentity", {
          identity: shortIdentity(preview.candidate_identity),
        })}
      </p>
      <div aria-label={t("skillDetail.sourceUpdate.filesHeading")} className="sh-source-update__files" role="group">
        <p className="sh-source-update__files-heading">{t("skillDetail.sourceUpdate.filesHeading")}</p>
        <ul className="sh-source-update__summary">
          {fileGroups.map((group) => (
            <li className={`sh-source-update__count sh-source-update__count--${group.key}`} key={group.key}>
              {t(group.labelKey as never)} {group.paths.length}
            </li>
          ))}
        </ul>
        {preview.files.length > 0 ? (
          <ul className="sh-source-update__paths">
            {preview.files.map((file) => (
              <li key={`${file.change}:${file.path}`}>{file.path}</li>
            ))}
          </ul>
        ) : (
          <p role="note">{t("skillDetail.sourceUpdate.filesNone")}</p>
        )}
      </div>
      {error ? <p role="alert">{t("skillDetail.sourceUpdate.failed", { error })}</p> : null}
      <div className="sh-source-update__actions">
        <Button disabled={committing} onClick={() => onDecide("take_upstream")} variant="primary">
          {t("skillDetail.sourceUpdate.confirmTakeUpstream")}
        </Button>
        <Button disabled={committing} onClick={() => onDecide("keep_local")} variant="secondary">
          {t("skillDetail.sourceUpdate.keepLocal")}
        </Button>
        <Button disabled={committing} onClick={() => onDecide("cancel")} variant="ghost">
          {t("skillDetail.sourceUpdate.cancelCommit")}
        </Button>
      </div>
    </div>
  );
}

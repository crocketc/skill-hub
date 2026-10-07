import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTimestamp } from "../../i18n";
import { describeNativeError } from "../../api/nativeErrors";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { skillLibraryKeys } from "../skills/api";
import type { SkillDetailFacade, SkillDetailSummary } from "./api";
import { skillDetailKeys } from "./api";
import { VersionUpdateNotice } from "./VersionUpdateNotice";

interface VersionTimelineProps {
  facade: SkillDetailFacade;
  skillId: string;
  summary?: SkillDetailSummary;
  userFacingDates?: boolean;
  reviewPresentation?: boolean;
}

function toggleComparedVersion(selected: string[], versionId: string): string[] {
  if (selected.includes(versionId)) return selected.filter((id) => id !== versionId);
  return selected.length === 2 ? [selected[1], versionId] : [...selected, versionId];
}

export function VersionTimeline({ facade, skillId, summary, userFacingDates = false, reviewPresentation = false }: VersionTimelineProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const [selected, setSelected] = useState<string[]>([]);
  const [compareRequested, setCompareRequested] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<string>();
  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string>();
  // AR-021：行内命名——用户显式为版本维护可读名称。
  const [renamingId, setRenamingId] = useState<string>();
  const [labelDraft, setLabelDraft] = useState("");
  const [renameError, setRenameError] = useState<string>();
  const [reviewResult, setReviewResult] = useState<string>();
  const commitGuardRef = useRef(false);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);

  const versionsQuery = useQuery({
    queryFn: () => facade.getVersions(skillId),
    queryKey: skillDetailKeys.versions(skillId),
  });
  const diffQuery = useQuery({
    enabled: compareRequested && selected.length === 2,
    queryFn: () => facade.getVersionDiff(skillId, selected[0], selected[1]),
    queryKey: selected.length === 2
      ? skillDetailKeys.versionDiff(skillId, selected[0], selected[1])
      : [...skillDetailKeys.versions(skillId), "comparison-idle"],
  });
  const impactQuery = useQuery({
    enabled: Boolean(rollbackTarget),
    queryFn: () => facade.getRollbackImpact(skillId, rollbackTarget ?? ""),
    queryKey: rollbackTarget
      ? skillDetailKeys.rollbackImpact(skillId, rollbackTarget)
      : [...skillDetailKeys.versions(skillId), "rollback-idle"],
  });

  const prepareRollback = (versionId: string) => {
    setCommitError(undefined);
    setRollbackTarget(versionId);
    queueMicrotask(() => previewHeadingRef.current?.focus());
  };
  const saveLabel = async (versionId: string) => {
    setRenameError(undefined);
    try {
      // 统一执行反馈（任务 4）：命名是单次写入，走 instant 模式给结果反馈。
      await runTrackedOperation({
        kind: "version_rename",
        label: t("skillDetail.tracker.renameVersionLabel"),
        mode: "instant",
        notifications,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({
          tone: "success",
          title: t("skillDetail.tracker.renameVersionSaved"),
          detail: labelDraft.trim(),
        }),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("skillDetail.tracker.renameVersionFailed"),
          detail: message,
        }),
        describeError: (error: unknown) =>
          describeNativeError(
            error,
            (key, describeOptions) => String(t(key as never, describeOptions as never)),
            "skillDetail.versions.renameFailed",
          ),
        run: () => facade.setVersionLabel(skillId, versionId, labelDraft.trim()),
      });
      await queryClient.invalidateQueries({ queryKey: skillDetailKeys.versions(skillId) });
      setRenamingId(undefined);
      setLabelDraft("");
    } catch (reason) {
      setRenameError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "skillDetail.versions.renameFailed"));
    }
  };
  const commitRollback = () => {
    if (!rollbackTarget || commitGuardRef.current || !impactQuery.data) return;
    commitGuardRef.current = true;
    setCommitPending(true);
    setCommitError(undefined);
    // 回滚切换当前版本指针，是用户可触发的单次写入：instant 模式只给结果
    // 反馈，不伪造可取消的后台阶段。
    // 结果用用户看得到的版本名表达，不是内部版本 id：优先取列表里的展示
    // 标签（用户命名 → vN 序号），查不到时才回退到该 id。
    const rollbackDisplay =
      versionsQuery.data?.find((version) => version.id === rollbackTarget)?.label
      ?? rollbackTarget;
    void runTrackedOperation({
      kind: "version_rollback",
      label: t("skillDetail.tracker.rollbackLabel"),
      mode: "instant",
      notifications,
      translate: (key, options) => String(t(key as never, options as never)),
      successNotice: () => ({
        tone: "success",
        title: t("skillDetail.tracker.rollbackSaved", { version: rollbackDisplay }),
      }),
      errorNotice: (_error, message) => ({
        tone: "danger",
        title: t("skillDetail.tracker.rollbackFailed"),
        detail: message,
      }),
      describeError: (error: unknown) =>
        describeNativeError(
          error,
          (key, describeOptions) => String(t(key as never, describeOptions as never)),
          "skillDetail.tracker.failureUnknown",
        ),
      run: () => facade.commitRollback(skillId, rollbackTarget),
    }).then(
      async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.versions(skillId) }),
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.relations(skillId) }),
          // 回滚会触发部署核对并改变洞察事实（操作历史/外部变化）。
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.insights(skillId) }),
          queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
        ]);
        setRollbackTarget(undefined);
        if (reviewPresentation) setReviewResult("已创建新的当前版本；受管链接继续跟随当前版本，独立拷贝保持原状。目标内容已完成示例基础检查；原始风险记录仍保留。");
      },
      () => setCommitError(t("skillDetail.versions.rollbackError")),
    ).finally(() => {
      commitGuardRef.current = false;
      setCommitPending(false);
    });
  };

  if (versionsQuery.isPending) return <p role="status">{t("skillDetail.versions.loading")}</p>;
  if (versionsQuery.isError) return <p role="alert">{t("skillDetail.versions.loadError")}</p>;

  return (
    <div className="sh-version-timeline">
      {summary && !reviewPresentation ? <VersionUpdateNotice summary={summary} /> : null}
      {reviewResult ? <p data-testid="review-version-result" role="status">{reviewResult}</p> : null}
      <ol>
        {versionsQuery.data.map((version) => (
          <li key={version.id}>
            <div className="sh-version-timeline__node" />
            <article>
              <div className="sh-version-timeline__heading">
                <h3>{version.label}</h3>
                {version.current ? <StatusBadge tone="info">{t("skillDetail.versions.current")}</StatusBadge> : null}
              </div>
              <p>
                {version.createdAt ? userFacingDates
                  ? formatTimestamp(version.createdAt, i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US")
                  : version.createdAt
                  : t("skillDetail.versions.timeUnknown")}
                {version.origin ? ` · ${t(`skillDetail.versions.origin.${version.origin}`)}` : ""}
              </p>
              <p>{t("skillDetail.versions.changes", version.changes)}</p>
              {renamingId === version.id ? (
                <div className="sh-version-timeline__rename">
                  <label>
                    <span className="sh-visually-hidden">{t("skillDetail.versions.labelLabel")}</span>
                    <input
                      aria-label={t("skillDetail.versions.labelLabel")}
                      maxLength={64}
                      onChange={(event) => setLabelDraft(event.target.value)}
                      placeholder={version.userLabel || version.label}
                      value={labelDraft}
                    />
                  </label>
                  <Button onClick={() => void saveLabel(version.id)} size="sm" variant="primary">
                    {t("skillDetail.versions.saveName")}
                  </Button>
                  <Button onClick={() => { setRenamingId(undefined); setLabelDraft(""); setRenameError(undefined); }} size="sm" variant="ghost">
                    {t("actions.cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => { setRenamingId(version.id); setLabelDraft(version.userLabel ?? ""); setRenameError(undefined); }}
                  size="sm"
                  variant="ghost"
                >
                  {t("skillDetail.versions.renameAria", { version: version.label })}
                </Button>
              )}
              {renamingId === version.id && renameError ? <p role="alert">{renameError}</p> : null}
              <label>
                <input
                  aria-label={t("skillDetail.versions.selectCompare", { version: version.label })}
                  checked={selected.includes(version.id)}
                  onChange={() => {
                    setCompareRequested(false);
                    setSelected((current) => toggleComparedVersion(current, version.id));
                  }}
                  type="checkbox"
                />
                {t("skillDetail.versions.compare")}
              </label>
              {!version.current ? (
                <Button onClick={() => prepareRollback(version.id)} size="sm" variant="ghost">
                  {reviewPresentation ? `恢复到 ${version.label}` : t("skillDetail.versions.rollbackTo", { version: version.label })}
                </Button>
              ) : reviewPresentation ? (
                // 原型紧凑行的槽位预留：当前版本没有恢复动作，用等宽占位
                // 接住槽位，各行命名/比较/恢复按钮起点保持一致。
                <span aria-hidden="true" className="sh-button sh-button--ghost sh-button--sm sh-version-timeline__slot-placeholder">
                  {`恢复到 ${version.label}`}
                </span>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
      <Button disabled={selected.length !== 2} onClick={() => setCompareRequested(true)} size="sm" variant="secondary">
        {t("skillDetail.versions.compareSelected")}
      </Button>
      {diffQuery.data ? (
        <div className="sh-version-timeline__diff" role="region" aria-label={t("skillDetail.versions.fileDetails.label")}>
          <p>{t("skillDetail.versions.added", { count: diffQuery.data.added.length })}</p>
          <p>{t("skillDetail.versions.changed", { count: diffQuery.data.changed.length })}</p>
          <p>{t("skillDetail.versions.removed", { count: diffQuery.data.removed.length })}</p>
          {(["added", "changed", "removed"] as const).map((kind) => (
            <section className="sh-version-timeline__file-group" key={kind}>
              <h4>{t(`skillDetail.versions.fileDetails.${kind}`)}</h4>
              {diffQuery.data[kind].length > 0 ? (
                <ul>
                  {diffQuery.data[kind].map((path) => <li key={path}><code>{path}</code></li>)}
                </ul>
              ) : <p>{t("skillDetail.versions.fileDetails.empty")}</p>}
            </section>
          ))}
        </div>
      ) : null}
      {rollbackTarget ? (
        <section aria-label={reviewPresentation ? "恢复影响预览" : t("skillDetail.versions.rollbackPreview")} role="region" className="sh-version-timeline__rollback">
          <h3 ref={previewHeadingRef} tabIndex={-1}>{reviewPresentation ? "恢复影响预览" : t("skillDetail.versions.rollbackPreview")}</h3>
          {impactQuery.isPending ? <p role="status">{t("skillDetail.versions.impactLoading")}</p> : null}
          {impactQuery.data ? (
            <>
              <p>{reviewPresentation ? "恢复会创建新的当前版本，原当前版本保留在历史中。" : t("skillDetail.versions.createsVersion")}</p>
              {reviewPresentation ? <><p>目标版本内容已进行示例基础检查；发现记录不会因恢复而清空。</p><p>受管链接：2 个，继续跟随新当前版本。独立拷贝：1 个，原样保留。</p></> : null}
              <ul>
                {impactQuery.data.deployments.map((deployment) => (
                  <li key={deployment.id}>
                    {deployment.affected
                      ? t("skillDetail.versions.deploymentUpdates", { label: deployment.label })
                      : t("skillDetail.versions.pinnedUnaffected", { label: deployment.label })}
                  </li>
                ))}
              </ul>
              <p>{reviewPresentation ? "恢复后重新执行基础安全检查" : t("skillDetail.versions.rerunBasic")}</p>
              <Button disabled={commitPending} loading={commitPending} onClick={commitRollback} size="sm">
                {reviewPresentation ? "确认创建恢复版本" : t("skillDetail.versions.confirmRollback")}
              </Button>
              <Button disabled={commitPending} onClick={() => setRollbackTarget(undefined)} size="sm" variant="ghost">
                {t("actions.cancel")}
              </Button>
            </>
          ) : null}
          {commitError ? <p role="alert">{commitError}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

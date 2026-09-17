import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { skillLibraryKeys } from "../skills/api";
import type { SkillDetailFacade, SkillDetailSummary } from "./api";
import { skillDetailKeys } from "./api";

interface TrialActionsProps {
  facade: SkillDetailFacade;
  skillId: string;
  summary: SkillDetailSummary;
}

export function TrialActions({ facade, skillId, summary }: TrialActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(summary.trialDue ?? "");
  const [pending, setPending] = useState<"date" | "convert" | "abandon">();
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState<string>();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
      queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
    ]);
  };
  // 结构化失败必须可读：原生命令以 AppError 对象拒绝，默认 String() 会得到
  // "[object Object]"。通知的补充说明与页面局部提示共用同一段描述。
  const describeFailure = (error: unknown) =>
    describeNativeError(
      error,
      (key, describeOptions) => String(t(key as never, describeOptions as never)),
      "skillDetail.tracker.failureUnknown",
    );

  // 统一执行反馈（任务 4）：试用日期与放弃试用都是用户可触发的单次写入，
  // 走 instant 模式；成功才刷新，失败原因由桥留下通知并保留页面局部提示。
  const saveDate = (due: string | null, kind: "date" | "convert") => {
    setPending(kind);
    setError(undefined);
    void runTrackedOperation({
      kind: "trial_review_date",
      label: t("skillDetail.trial.saveDate"),
      mode: "instant",
      notifications,
      translate: (key, options) => String(t(key as never, options as never)),
      successNotice: () => ({
        tone: "success",
        title: due
          ? t("skillDetail.trial.saved", { date: due })
          : t("skillDetail.trial.converted"),
      }),
      errorNotice: (_error, message) => ({
        tone: "danger",
        title: t("skillDetail.trial.saveError"),
        detail: message,
      }),
      describeError: describeFailure,
      run: () => facade.setTrial(skillId, due),
    }).then(
      async () => {
        await refresh();
        setEditing(false);
        setAnnouncement(
          due
            ? t("skillDetail.trial.saved", { date: due })
            : t("skillDetail.trial.converted"),
        );
      },
      () => setError(t("skillDetail.trial.saveError")),
    ).finally(() => setPending(undefined));
  };
  const abandon = () => {
    setPending("abandon");
    setError(undefined);
    void runTrackedOperation({
      kind: "abandon_trial",
      label: t("skillDetail.tracker.abandonTrialLabel"),
      mode: "instant",
      notifications,
      translate: (key, options) => String(t(key as never, options as never)),
      errorNotice: (_error, message) => ({
        tone: "danger",
        title: t("skillDetail.tracker.abandonTrialFailed"),
        detail: message,
      }),
      describeError: describeFailure,
      run: () => facade.emitIntent({ skillId, type: "abandon_trial" }),
    }).catch(() => {
      setError(t("skillDetail.trial.abandonError"));
    }).finally(() => setPending(undefined));
  };

  return (
    <div className="sh-trial-actions">
      {editing ? (
        <div className="sh-trial-actions__date">
          <label>
            {t("skillDetail.trial.reviewDate")}
            <input
              disabled={pending === "date"}
              onChange={(event) => setDate(event.currentTarget.value)}
              type="date"
              value={date}
            />
          </label>
          <Button
            disabled={!date || pending === "date"}
            loading={pending === "date"}
            onClick={() => saveDate(date, "date")}
            size="sm"
          >
            {t("skillDetail.trial.saveDate")}
          </Button>
          <Button disabled={pending === "date"} onClick={() => setEditing(false)} size="sm" variant="ghost">
            {t("actions.cancel")}
          </Button>
        </div>
      ) : summary.lifecycle === "trial" ? (
        <div className="sh-trial-actions__buttons">
          <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
            {t("skillDetail.trial.extend")}
          </Button>
          <Button loading={pending === "convert"} onClick={() => saveDate(null, "convert")} size="sm">
            {t("skillDetail.trial.convert")}
          </Button>
          <Button loading={pending === "abandon"} onClick={abandon} size="sm" variant="ghost">
            {t("skillDetail.trial.abandon")}
          </Button>
        </div>
      ) : (
        <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
          {t("skillDetail.trial.set")}
        </Button>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {announcement ? <p aria-live="polite">{announcement}</p> : null}
    </div>
  );
}

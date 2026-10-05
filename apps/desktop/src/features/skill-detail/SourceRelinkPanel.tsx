import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { type SourceRelinkInput } from "./api";

export interface SourceRelinkFacade {
  /** 解析显式来源类型并调用 relink_source；协议选择由用户做出，前端不猜。 */
  relinkSource: (skillId: string, source: SourceRelinkInput) => Promise<{ messageCode: string }>;
}

interface SourceRelinkPanelProps {
  facade: SourceRelinkFacade;
  skillId: string;
}

type SourceKind = SourceRelinkInput["kind"];

const KINDS: SourceKind[] = ["local", "https", "git"];

/** 只做形态守门（与所选类型一致），完整校验仍归后端；不给自由文本猜协议的机会。 */
function shapeProblem(kind: SourceKind, value: string): boolean {
  const trimmed = value.trim();
  if (kind === "https") return !/^https:\/\//i.test(trimmed);
  if (kind === "git") return !/^(git@|ssh:\/\/)/i.test(trimmed) && !/\.git$/i.test(trimmed);
  // 本地目录：内容若明显是远程地址，说明类型选错了——拒绝提交而不是猜测协议。
  return trimmed === "" || /^(https?:\/\/|git@|ssh:\/\/)/i.test(trimmed);
}

/**
 * FE-06 / G-15 来源重新关联：把受管 Skill 关联到新的本地/远程来源。
 * 来源类型必须显式选择（本地目录 / HTTPS / Git），输入按所选类型收集——
 * 绝不从自由文本猜测协议；后端拒绝时保留已输入的来源事实供修正。
 */
export function SourceRelinkPanel({ facade, skillId }: SourceRelinkPanelProps) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const [kind, setKind] = useState<SourceKind>("local");
  const [sourceValue, setSourceValue] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = sourceValue.trim();
  const shapeInvalid = trimmed !== "" && shapeProblem(kind, trimmed);
  const canSubmit = trimmed !== "" && !shapeInvalid && !pending;

  // 统一执行反馈（任务 4）：重新关联是一次写入命令，走 instant 模式。
  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await runTrackedOperation({
        kind: "source_relink",
        label: t("skillDetail.tracker.relinkLabel"),
        mode: "instant",
        notifications,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({ tone: "success", title: t("skillDetail.sourceRelink.done") }),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("skillDetail.tracker.relinkFailed"),
          detail: message,
        }),
        describeError: (error: unknown) =>
          describeNativeError(
            error,
            (key, describeOptions) => String(t(key as never, describeOptions as never)),
            "skillDetail.sourceRelink.failureUnknown",
          ),
        run: () => facade.relinkSource(skillId, { kind, value: trimmed }),
      });
      setDone(true);
      setSourceValue("");
    } catch (reason) {
      // 结构化 AppError 直接 String() 会变成 "[object Object]"；统一走
      // 分类文案，让失败原因以中英文可读形式呈现。输入保留原值供修正。
      setError(
        describeNativeError(
          reason,
          (key, options) => String(t(key as never, options as never)),
          "skillDetail.sourceRelink.failureUnknown",
        ),
      );
      setDone(false);
    } finally {
      setPending(false);
    }
  };

  const inputLabel = t(`skillDetail.sourceRelink.inputLabel.${kind}` as never);
  const inputPlaceholder = t(`skillDetail.sourceRelink.inputPlaceholder.${kind}` as never);

  return (
    <section aria-label={t("skillDetail.sourceRelink.ariaLabel")} className="sh-source-relink">
      <div role="radiogroup" aria-label={t("skillDetail.sourceRelink.kindLabel")} className="sh-source-relink__kinds">
        {KINDS.map((option) => (
          <label className="sh-source-relink__kind" key={option}>
            <input
              checked={kind === option}
              disabled={pending}
              name="source-relink-kind"
              onChange={() => setKind(option)}
              type="radio"
              value={option}
            />
            <span>{t(`skillDetail.sourceRelink.kind.${option}` as never)}</span>
          </label>
        ))}
      </div>
      <div className="sh-source-relink__row">
        <input
          aria-label={inputLabel}
          disabled={pending}
          onChange={(event) => setSourceValue(event.target.value)}
          placeholder={inputPlaceholder}
          type="text"
          value={sourceValue}
        />
        <Button disabled={!canSubmit} onClick={() => void submit()} variant="secondary">
          {t("skillDetail.sourceRelink.submit")}
        </Button>
      </div>
      {shapeInvalid ? <p role="alert">{t(`skillDetail.sourceRelink.shapeInvalid.${kind}` as never)}</p> : null}
      {done ? <p role="status">{t("skillDetail.sourceRelink.done")}</p> : null}
      {error ? <p role="alert">{t("skillDetail.sourceRelink.failed", { error })}</p> : null}
    </section>
  );
}

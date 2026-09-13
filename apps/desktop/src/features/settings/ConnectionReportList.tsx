import { useTranslation } from "react-i18next";
import { describeNativeError, keyedMessage } from "../../api/nativeErrors";
import { Icon } from "../../ui/Icon";
import type { ConnectionTestResult } from "./llmApi";

/**
 * Three-level connection report shared by saved provider rows and the draft
 * form inside the add/edit drawer: service reachability, model callability and
 * structured-output compatibility. Each level answers a different question and
 * carries a decorative status icon so the state never relies on colour alone.
 *
 * A model that answers plain text is *callable* even when the profile's
 * structured-output strategy is unusable, so the third level is reported on
 * its own and never rewritten as a model protocol mismatch. Levels that were
 * not attempted (because a lower level failed) are shown as unverified rather
 * than omitted, so the row always reads as three distinct questions.
 *
 * M-05：失败码先走集中 presenter 的本地化文案；无法映射的码不内嵌进句子
 * （避免中英混排），折叠进可选的"诊断详情"，默认不展开。
 */
export function ConnectionReportList({ report }: { report: ConnectionTestResult }) {
  const { t } = useTranslation();

  const model = report.model;
  const structured = report.structured;

  const modelFailureCode = report.model_failure_code;
  const modelFailureMessage =
    model?.ok === true
      ? null
      : modelFailureCode
        ? describeNativeError(
            { code: modelFailureCode, severity: "error", params: {}, actions: [] },
            (key, options) => String(t(key as never, options as never)),
            "settings.llm.modelFailed",
          )
        : t("settings.llm.modelFailed");
  // 已有专属文案的错误码不需要额外诊断；只有未映射的码折叠展示原始值。
  const showModelDiagnostics =
    model?.ok !== true &&
    modelFailureCode !== null &&
    modelFailureCode !== undefined &&
    keyedMessage(modelFailureCode, undefined) === null;

  const structuredFailureCode = report.structured_failure_code;
  // The structured level owns its own copy: an unsupported structured strategy
  // is a capability warning, never the model-level protocol mismatch message.
  const showStructuredDiagnostics =
    structured?.ok !== true &&
    structuredFailureCode !== null &&
    structuredFailureCode !== undefined;

  const endpointLatency =
    report.endpoint.latency_ms !== null && report.endpoint.latency_ms !== undefined
      ? ` (${report.endpoint.latency_ms} ms)`
      : "";

  return (
    <ul aria-live="polite" className="sh-settings-provider__report">
      <li
        className={`sh-settings-provider__level${
          report.endpoint.reachable ? " sh-settings-provider__level--ok" : ""
        }`}
      >
        <Icon
          className="sh-settings-provider__level-icon"
          name={report.endpoint.reachable ? "success" : "failure"}
          size={16}
        />
        <span>
          {report.endpoint.reachable
            ? `${t("settings.llm.endpointOk")}${endpointLatency}`
            : t("settings.llm.endpointFailed")}
        </span>
      </li>
      <li
        className={`sh-settings-provider__level${
          model?.ok === true ? " sh-settings-provider__level--ok" : ""
        }`}
      >
        <Icon
          className="sh-settings-provider__level-icon"
          name={model === null || model === undefined ? "info" : model.ok ? "success" : "failure"}
          size={16}
        />
        <span>
          {model?.ok === true ? (
            t("settings.llm.modelOk")
          ) : (
            <>
              <span>{modelFailureMessage}</span>
              {showModelDiagnostics ? (
                <details className="sh-settings-local-note">
                  <summary>{t("settings.llm.diagnosticSummary")}</summary>
                  {modelFailureCode}
                </details>
              ) : null}
            </>
          )}
        </span>
      </li>
      <li
        className={`sh-settings-provider__level${
          structured?.ok === true
            ? " sh-settings-provider__level--ok"
            : structured
              ? " sh-settings-provider__level--warning"
              : ""
        }`}
      >
        <Icon
          className="sh-settings-provider__level-icon"
          name={
            structured === null || structured === undefined
              ? "info"
              : structured.ok
                ? "success"
                : "warning"
          }
          size={16}
        />
        <span>
          {structured === null || structured === undefined ? (
            t("settings.llm.structuredSkipped")
          ) : structured.ok ? (
            t("settings.llm.structuredOk")
          ) : (
            <>
              <span>{t("settings.llm.structuredUnavailable")}</span>
              {showStructuredDiagnostics ? (
                <details className="sh-settings-local-note">
                  <summary>{t("settings.llm.diagnosticSummary")}</summary>
                  {structuredFailureCode}
                </details>
              ) : null}
            </>
          )}
        </span>
      </li>
    </ul>
  );
}

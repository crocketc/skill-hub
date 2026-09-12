import { useTranslation } from "react-i18next";
import { describeNativeError, keyedMessage } from "../../api/nativeErrors";
import { Icon } from "../../ui/Icon";
import type { ConnectionTestResult } from "./llmApi";

/**
 * Two-level connection report shared by saved provider rows and the draft
 * form inside the add/edit drawer (P1-03): endpoint reachability with latency
 * plus the model check, each with a decorative status icon so the state never
 * relies on color alone.
 *
 * M-05：模型级失败码先走集中 presenter 的本地化文案；无法映射的码不再
 * 内嵌进句子（避免中英混排），折叠进可选的"诊断详情"，默认不展开。
 */
export function ConnectionReportList({ report }: { report: ConnectionTestResult }) {
  const { t } = useTranslation();
  const failureCode = report.model_failure_code;
  const failureMessage =
    report.model?.ok === true
      ? null
      : failureCode
        ? describeNativeError(
            {
              code: failureCode,
              severity: "error",
              params: {},
              actions: [],
            },
            (key, options) => String(t(key as never, options as never)),
            "settings.llm.modelFailed",
          )
        : t("settings.llm.modelFailed");
  // 已有专属文案的错误码不需要额外诊断；只有未映射的码折叠展示原始值。
  const showDiagnostics =
    report.model?.ok !== true && failureCode !== null && failureCode !== undefined && keyedMessage(failureCode, undefined) === null;

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
            ? `${t("settings.llm.endpointOk")}${
                report.endpoint.latency_ms !== null && report.endpoint.latency_ms !== undefined
                  ? ` (${report.endpoint.latency_ms} ms)`
                  : ""
              }`
            : t("settings.llm.endpointFailed")}
        </span>
      </li>
      <li
        className={`sh-settings-provider__level${
          report.model?.ok === true ? " sh-settings-provider__level--ok" : ""
        }`}
      >
        <Icon
          className="sh-settings-provider__level-icon"
          name={report.model?.ok === true ? "success" : "failure"}
          size={16}
        />
        <span>
          {report.model?.ok === true ? (
            t("settings.llm.modelOk")
          ) : (
            <>
              <span>{failureMessage}</span>
              {showDiagnostics ? (
                <details className="sh-settings-local-note">
                  <summary>{t("settings.llm.diagnosticSummary")}</summary>
                  {failureCode}
                </details>
              ) : null}
            </>
          )}
        </span>
      </li>
    </ul>
  );
}

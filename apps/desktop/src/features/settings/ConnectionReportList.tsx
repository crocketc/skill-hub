import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Icon } from "../../ui/Icon";
import type { ConnectionTestResult } from "./llmApi";

/**
 * Two-level connection report shared by saved provider rows and the draft
 * form inside the add/edit drawer (P1-03): endpoint reachability with latency
 * plus the model check, each with a decorative status icon so the state never
 * relies on color alone.
 */
export function ConnectionReportList({ report }: { report: ConnectionTestResult }) {
  const { t } = useTranslation();

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
          {report.model?.ok === true
            ? t("settings.llm.modelOk")
            : report.model_failure_code
              ? describeNativeError(
                  {
                    code: report.model_failure_code,
                    severity: "error",
                    params: {},
                    actions: [],
                  },
                  (key, options) => String(t(key as never, options as never)),
                  "settings.llm.modelFailed",
                )
              : t("settings.llm.modelFailed", { code: "unknown" })}
        </span>
      </li>
    </ul>
  );
}

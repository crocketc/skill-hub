import { render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ConnectionReportList } from "./ConnectionReportList";
import type { ConnectionTestResult } from "./llmApi";

async function renderReport(report: ConnectionTestResult) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConnectionReportList report={report} />
    </I18nextProvider>,
  );
  return screen.getByRole("list");
}

it("reports the three levels as separate, labelled rows", async () => {
  const list = await renderReport({
    endpoint: { reachable: true, latency_ms: 18 },
    model: { ok: true, latency_ms: 120 },
    model_failure_code: null,
    structured: { ok: true, latency_ms: 240 },
    structured_failure_code: null,
  });

  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("服务可达 (18 ms)");
  // The model level answers a different question than the endpoint level.
  expect(rows[1]).toHaveTextContent("模型可调用");
  expect(rows[2]).toHaveTextContent("结构化输出兼容");
});

it("shows a skipped structured level when the model level never ran", async () => {
  const list = await renderReport({
    endpoint: { reachable: false, latency_ms: null },
    model: null,
    model_failure_code: "llm.endpoint_unreachable",
    structured: null,
    structured_failure_code: null,
  });

  const rows = within(list).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("服务不可达");
  // An unattempted level is reported as unverified, never as a success.
  expect(rows[2]).toHaveTextContent("结构化输出未验证");
  expect(list).not.toHaveTextContent("结构化输出兼容");
  expect(list).not.toHaveTextContent("模型可调用");
});

it("keeps a callable model usable when only structured output fails", async () => {
  const list = await renderReport({
    endpoint: { reachable: true, latency_ms: 20 },
    model: { ok: true, latency_ms: 90 },
    model_failure_code: null,
    structured: { ok: false, latency_ms: 90 },
    structured_failure_code: "llm.protocol_incompatible",
  });

  const rows = within(list).getAllByRole("listitem");
  // The model answered plain text, so it stays callable.
  expect(rows[1]).toHaveTextContent("模型可调用");
  expect(rows[2]).toHaveTextContent("结构化输出不可用");
  // A structured-only failure must not be reported as a model protocol mismatch.
  expect(list).not.toHaveTextContent("模型服务协议不兼容");
  // The raw code is available as a collapsed diagnostic, never in the sentence.
  const details = rows[2]!.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.textContent).toContain("llm.protocol_incompatible");
  const sentence = rows[2]!.querySelector("span span")?.textContent ?? "";
  expect(sentence).toContain("结构化输出不可用");
  expect(sentence).not.toContain("llm.protocol_incompatible");
});

it("does not rely on colour alone to distinguish the three levels", async () => {
  const list = await renderReport({
    endpoint: { reachable: true, latency_ms: 12 },
    model: { ok: true, latency_ms: 30 },
    model_failure_code: null,
    structured: { ok: false, latency_ms: 45 },
    structured_failure_code: "llm.structured_unavailable",
  });

  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  // Every level carries a decorative status icon alongside its text.
  expect(rows.every((row) => row.querySelector("svg") !== null)).toBe(true);
});

it("explains a model-level authorization failure through the localized presenter", async () => {
  const list = await renderReport({
    endpoint: { reachable: true, latency_ms: 15 },
    model: { ok: false, latency_ms: null },
    model_failure_code: "llm.auth_failed",
    structured: null,
    structured_failure_code: null,
  });

  expect(list).toHaveTextContent("模型服务拒绝了凭据，请重新检查 API 密钥。");
  expect(list).not.toHaveTextContent("模型可调用");
});

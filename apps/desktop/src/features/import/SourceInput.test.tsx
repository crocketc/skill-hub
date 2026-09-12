import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { SourceInput } from "./SourceInput";

async function renderSourceInput(props: Partial<React.ComponentProps<typeof SourceInput>> = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SourceInput value="" onChange={vi.fn()} {...props} />
    </I18nextProvider>,
  );
}

it("shows the parse-only boundary for npx references without executing a command", async () => {
  await renderSourceInput({ value: "npx skills add owner/repository" });

  expect(screen.getByRole("textbox", { name: "来源" })).toHaveValue("npx skills add owner/repository");
  expect(screen.getByText("仅解析来源，不会执行 npx 命令")).toBeVisible();
});

it("emits controlled input changes", async () => {
  const onChange = vi.fn();
  await renderSourceInput({ onChange });

  fireEvent.change(screen.getByRole("textbox", { name: "来源" }), {
    target: { value: "C:/skills" },
  });

  expect(onChange).toHaveBeenCalledWith("C:/skills");
});

it("lists scanned sources with explicit bulk selection controls", async () => {
  const onToggleSource = vi.fn();
  const onSelectAllSources = vi.fn();
  await renderSourceInput({
    onSelectAllSources,
    onToggleSource,
    selectedSources: ["C:/codex/skills"],
    suggestedSources: ["C:/codex/skills", "C:/claude/skills"],
  });

  expect(screen.getByText("初始化扫描来源")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "C:/codex/skills" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "C:/claude/skills" }));
  fireEvent.click(screen.getByRole("button", { name: "全选扫描来源" }));
  expect(onToggleSource).toHaveBeenCalledWith("C:/claude/skills");
  expect(onSelectAllSources).toHaveBeenCalledOnce();
});

it("offers a clear-all action when every scanned source is selected", async () => {
  const onSelectAllSources = vi.fn();
  await renderSourceInput({
    onSelectAllSources,
    selectedSources: ["C:/codex/skills", "C:/claude/skills"],
    suggestedSources: ["C:/codex/skills", "C:/claude/skills"],
  });

  fireEvent.click(screen.getByRole("button", { name: "全不选扫描来源" }));
  expect(onSelectAllSources).toHaveBeenCalledOnce();
});

it("labels the batch action as acquiring selected directory candidates at the wizard level", async () => {
  // 解析动作已上移到向导底部操作区；“读取已选目录候选”的标注语义由
  // ImportWizard.test.tsx 的“keeps the acquire action available…”用例覆盖。
  await renderSourceInput({
    selectedSources: ["C:/codex/skills"],
    suggestedSources: ["C:/codex/skills"],
    value: "C:/codex/skills",
  });

  expect(screen.getByRole("checkbox", { name: "C:/codex/skills" })).toBeChecked();
});

it("offers a native directory picker when the host provides one", async () => {
  const onPickLocalPath = vi.fn();
  await renderSourceInput({ onPickLocalPath });

  fireEvent.click(screen.getByRole("button", { name: "选择本地目录" }));

  expect(onPickLocalPath).toHaveBeenCalledOnce();
});

it("does not repeat a parsed local path in a descriptor block", async () => {
  await renderSourceInput({
    descriptor: {
      displayTarget: "C:/picked/skills",
      executesCommand: false,
      input: "C:/picked/skills",
      kind: "local_path",
    },
    value: "C:/picked/skills",
  });

  expect(screen.queryByLabelText("已识别来源")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "来源" })).toHaveValue("C:/picked/skills");
});

it("keeps the descriptor block for non-local sources", async () => {
  await renderSourceInput({
    descriptor: {
      displayTarget: "owner/repository",
      executesCommand: false,
      input: "https://github.com/owner/repository",
      kind: "git",
    },
    value: "https://github.com/owner/repository",
  });

  expect(screen.getByLabelText("已识别来源")).toBeVisible();
  expect(screen.getByText("owner/repository")).toBeVisible();
});

// —— M-29：已选来源列表（状态、单删、批量删、清空、聚焦） ——

it("lists every selected source as unscanned before any scan happens", async () => {
  await renderSourceInput({
    onClearSources: vi.fn(),
    onRemoveSource: vi.fn(),
    onRemoveSources: vi.fn(),
    selectedSources: ["C:/codex/skills", "C:/manual/skills"],
    suggestedSources: ["C:/codex/skills"],
  });

  const list = screen.getByRole("list", { name: "已选来源" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText("C:/codex/skills")).toBeVisible();
  expect(within(items[1]).getByText("C:/manual/skills")).toBeVisible();
  expect(within(items[0]).getByText("未扫描")).toBeVisible();
  expect(within(items[1]).getByText("未扫描")).toBeVisible();
});

it("shows scanned counts and failed reasons per source in the selected list", async () => {
  await renderSourceInput({
    onRemoveSource: vi.fn(),
    selectedSources: ["C:/ok/skills", "C:/broken/skills"],
    sourceStatuses: {
      "C:/broken/skills": { kind: "failed", reason: "权限不足" },
      "C:/ok/skills": { kind: "scanned", count: 3 },
    },
  });

  expect(screen.getByText("3 个候选")).toBeVisible();
  expect(screen.getByText("扫描失败")).toBeVisible();
  expect(screen.getByText("权限不足")).toBeVisible();
});

it("supports per-item removal, marked bulk removal, and clear-all", async () => {
  const onClearSources = vi.fn();
  const onRemoveSource = vi.fn();
  const onRemoveSources = vi.fn();
  const user = userEvent.setup();
  await renderSourceInput({
    onClearSources,
    onRemoveSource,
    onRemoveSources,
    selectedSources: ["C:/a/skills", "C:/b/skills"],
  });

  await user.click(screen.getByRole("button", { name: "移除已选来源 C:/a/skills" }));
  expect(onRemoveSource).toHaveBeenCalledWith("C:/a/skills");
  expect(onRemoveSources).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("checkbox", { name: "选中来源 C:/b/skills 以便批量删除" }));
  await user.click(screen.getByRole("button", { name: "删除所选（1）" }));
  expect(onRemoveSources).toHaveBeenCalledWith(["C:/b/skills"]);

  await user.click(screen.getByRole("button", { name: "全部清空" }));
  expect(onClearSources).toHaveBeenCalledOnce();
});

it("focuses the highlighted source entry and reports it as applied", async () => {
  const onFocusedSourceApplied = vi.fn();
  await renderSourceInput({
    focusedSource: "C:/a/skills",
    onFocusedSourceApplied,
    onRemoveSource: vi.fn(),
    selectedSources: ["C:/a/skills", "C:/b/skills"],
  });

  const item = within(screen.getByRole("list", { name: "已选来源" })
    .querySelector("li") as HTMLElement);
  expect(document.activeElement).toBe(item.getByText("C:/a/skills").closest("li"));
  expect(onFocusedSourceApplied).toHaveBeenCalledOnce();
});

import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { SourceInput } from "./SourceInput";

async function renderSourceInput(props: Partial<React.ComponentProps<typeof SourceInput>> = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SourceInput value="" onChange={vi.fn()} onParse={vi.fn()} {...props} />
    </I18nextProvider>,
  );
}

it("shows the parse-only boundary for npx references without executing a command", async () => {
  const onParse = vi.fn();
  await renderSourceInput({ onParse, value: "npx skills add owner/repository" });

  expect(screen.getByRole("textbox", { name: "来源" })).toHaveValue("npx skills add owner/repository");
  expect(screen.getByText("仅解析来源，不会执行 npx 命令")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "解析来源" }));
  expect(onParse).toHaveBeenCalledOnce();
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

it("labels the batch action as acquiring selected directory candidates", async () => {
  const onParse = vi.fn();
  await renderSourceInput({
    actionLabel: "读取已选目录候选",
    onParse,
    selectedSources: ["C:/codex/skills"],
    suggestedSources: ["C:/codex/skills"],
    value: "C:/codex/skills",
  });

  fireEvent.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(onParse).toHaveBeenCalledOnce();
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

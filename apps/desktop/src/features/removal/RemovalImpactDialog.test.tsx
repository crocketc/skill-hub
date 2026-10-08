import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { removalImpactFixture, type RemovalChoice, type RemovalImpact } from "./api";
import { RemovalImpactDialog } from "./RemovalImpactDialog";

type ConfirmHandler = (
  choices: Record<string, RemovalChoice>,
  confirmedSharedTargets: ReadonlySet<string>,
) => void;

/** 两条复制部署共用同一物理目录：逐项显式确认的最小场景。 */
function sharedCopyImpact(): RemovalImpact {
  return {
    ...removalImpactFixture(),
    deployments: [
      {
        id: "copy-a",
        label: "Codex CLI",
        path: "C:/shared/skills",
        physicalId: "shared-skills",
        mode: "managed_copy",
        targetId: "target-shared",
        agentId: "codex-cli",
      },
      {
        id: "copy-b",
        label: "Claude Code",
        path: "C:/shared/skills",
        physicalId: "shared-skills",
        mode: "managed_copy",
        targetId: "target-shared",
        agentId: "claude",
      },
    ],
  };
}

async function renderDialog(
  impact: RemovalImpact = removalImpactFixture(),
  locale: "en-US" | "zh-CN" = "zh-CN",
  onConfirm: ConfirmHandler = () => undefined,
  error?: string,
) {
  const i18n = await createSkillHubI18n([locale]);
  render(
    <I18nextProvider i18n={i18n}>
      <RemovalImpactDialog error={error} impact={impact} onConfirm={onConfirm} />
    </I18nextProvider>,
  );
}

// #12-7 重构：摘要优先＋分组呈现＋预勾默认＋可改＋明细默认收起。
// 逐行必选下拉（无默认值）被取代；确认按钮不再依赖逐行手动选择。
it("pre-checks safe defaults so the deletion can be confirmed immediately", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn<ConfirmHandler>();
  await renderDialog(removalImpactFixture(), "zh-CN", onConfirm);

  // 复制部署默认「保留为独立拷贝」；链接部署固定删除、无选择控件。
  const keepRadios = screen.getAllByRole("radio", { name: /保留为独立拷贝/ });
  expect(keepRadios).toHaveLength(1);
  expect(keepRadios[0]).toBeChecked();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

  const confirm = screen.getByRole("button", { name: "确认从库中删除" });
  expect(confirm).toBeEnabled();
  await user.click(confirm);

  // 链接部署固定随删除移除；拷贝默认保留为独立拷贝。
  expect(onConfirm).toHaveBeenCalledWith(
    { codex: "remove_deployment", claude: "convert_to_copy" },
    expect.any(Set),
  );
});

it("keeps the link group fixed on deletion and drops the old keep option", async () => {
  await renderDialog();

  expect(screen.getByText("将删除此处链接文件")).toBeTruthy();
  // 链接行不提供选择控件：删除链接文件是删除行为的固定结果。
  expect(screen.getAllByRole("radio", { name: /保留为独立拷贝/ })).toHaveLength(1);
  // 旧「保留目标处的文件（keep_deployed）」选项不再出现在单删确认里。
  expect(screen.queryByText(/保留目标处的文件/)).not.toBeInTheDocument();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});

it("changes the copy decision to deleting the copy at the target", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn<ConfirmHandler>();
  await renderDialog(removalImpactFixture(), "zh-CN", onConfirm);

  // 选项后果用用户语言说明。
  expect(screen.getByText("目标目录中的拷贝文件将被删除")).toBeTruthy();
  await user.click(screen.getByRole("radio", { name: /连拷贝一起删/ }));

  await user.click(screen.getByRole("button", { name: "确认从库中删除" }));
  expect(onConfirm).toHaveBeenCalledWith(
    { codex: "remove_deployment", claude: "remove_deployment" },
    expect.any(Set),
  );
});

it("leads with an impact summary and keeps per-group details collapsed", async () => {
  await renderDialog({ ...removalImpactFixture(), importRelationCount: 2 });

  // 摘要先行：中央删除、链接、拷贝默认、导入关系各占一行。
  expect(screen.getByText(/该 Skill 的记录、内容与版本历史将被删除/)).toBeTruthy();
  expect(screen.getByText("链接部署 1 处：链接文件将随删除一并移除")).toBeTruthy();
  expect(screen.getByText(/复制部署 1 处：默认保留为独立拷贝/)).toBeTruthy();
  expect(screen.getByText("导入拷贝关系 2 条：关系记录随技能删除；原件文件不受影响")).toBeTruthy();
  // 用户语言，不暴露内部词「导入登记」。
  expect(screen.queryByText(/导入登记/)).not.toBeInTheDocument();

  // 分组明细默认收起。
  for (const label of ["链接部署", "复制部署"]) {
    const group = screen.getByText(label).closest("details");
    expect(group).not.toHaveAttribute("open");
  }
});

it("omits the imported-copy summary when no relation count is reported", async () => {
  await renderDialog();

  expect(screen.queryByText(/导入拷贝关系/)).not.toBeInTheDocument();
});

it("requires explicit per-item confirmation before deleting a shared directory", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn<ConfirmHandler>();
  await renderDialog(sharedCopyImpact(), "zh-CN", onConfirm);

  const confirm = screen.getByRole("button", { name: "确认从库中删除" });
  // 默认全部保留：无需确认即可提交。
  expect(confirm).toBeEnabled();

  await user.click(screen.getAllByRole("radio", { name: /连拷贝一起删/ })[0]);
  // 分组摘要出现「需逐项确认」提示；未勾选前不能提交。
  expect(screen.getByText("需逐项确认")).toBeTruthy();
  const checkbox = screen.getByRole("checkbox", { name: /我确认删除其中的文件/ });
  expect(checkbox).not.toBeChecked();
  expect(confirm).toBeDisabled();

  await user.click(checkbox);
  expect(confirm).toBeEnabled();

  await user.click(confirm);
  expect(onConfirm).toHaveBeenCalledWith(
    { "copy-a": "remove_deployment", "copy-b": "convert_to_copy" },
    new Set(["copy-a"]),
  );
});

it("names groups, defaults and consequences in English", async () => {
  await renderDialog(removalImpactFixture(), "en-US");

  expect(screen.getByText("Skill library: the Skill's record, contents and version history will be deleted")).toBeTruthy();
  expect(screen.getByText("Link deployments 1: the link files will be removed along with it")).toBeTruthy();
  expect(screen.getByText(/Copy deployments 1: kept as independent copies by default/)).toBeTruthy();
  expect(screen.getByText("The link file here will be removed")).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Keep as an independent copy/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Delete the copy too/ })).toBeTruthy();
});

it("names the object as deleting the library Skill and states retention and recovery up front", async () => {
  await renderDialog();

  // 对象 4 唯一名称“删除库中 Skill”：不再共用笼统的“从托管库移除”。
  expect(screen.getByRole("heading", { name: "从库中删除 PDF Reader 吗？" })).toBeTruthy();
  expect(screen.queryByText(/要从托管库移除/)).not.toBeInTheDocument();

  // 固定两行：保留什么 + 恢复方式（如实提示仅备份可恢复）。
  expect(screen.getByText(/保留：SkillHub 之外的原件文件不受影响/)).toBeTruthy();
  expect(screen.getByText(/恢复：从库中删除无法在应用内撤销/)).toBeTruthy();
  expect(screen.getByText(/导出备份/)).toBeTruthy();
});

it("moves focus into the impact dialog on open and restores it to the trigger on close", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);

  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)} type="button">打开删除影响</button>
        {open ? (
          <RemovalImpactDialog
            impact={removalImpactFixture()}
            onCancel={() => setOpen(false)}
            onConfirm={() => undefined}
          />
        ) : null}
      </>
    );
  }

  render(
    <I18nextProvider i18n={i18n}>
      <Host />
    </I18nextProvider>,
  );

  const trigger = screen.getByRole("button", { name: "打开删除影响" });
  trigger.focus();
  await user.click(trigger);

  expect(screen.getByRole("heading", { name: /从库中删除/ })).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(trigger).toHaveFocus();
});

it("presents the commit failure as an icon-plus-text alert instead of bare prose", async () => {
  await renderDialog(removalImpactFixture(), "zh-CN", () => undefined, "删除未完成。集中库未被改动，请检查后重试。");

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("删除未完成。集中库未被改动，请检查后重试。");
  expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

// W1-2：删除级联清理编辑草稿——有草稿时影响矩阵出现草稿维度，
// 确认说明区追加「将同时删除草稿」；无草稿时两者都不出现。
it("lists unfinished edit drafts and states their deletion only when drafts exist", async () => {
  const impact = { ...removalImpactFixture(), draftCount: 3 };

  await renderDialog(impact);

  expect(screen.getByText("未完成的编辑草稿：3 项")).toBeTruthy();
  expect(screen.getByText("删除将同时删除该技能未完成的编辑草稿。")).toBeTruthy();
});

it("omits the draft dimension and draft confirmation copy when the skill has no drafts", async () => {
  await renderDialog();

  expect(screen.queryByText(/未完成的编辑草稿/)).not.toBeInTheDocument();
  expect(screen.queryByText(/编辑草稿/)).not.toBeInTheDocument();
});

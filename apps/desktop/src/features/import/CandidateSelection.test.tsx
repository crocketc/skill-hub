import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportCandidate } from "./api";
import { CandidateSelection } from "./CandidateSelection";

const candidates: ImportCandidate[] = [
  {
    basicCheck: "passed",
    id: "pdf-reader",
    name: "PDF Reader",
    ownership: "unknown",
    path: "C:/skills/pdf-reader",
    source: {
      displayTarget: "C:/skills",
      executesCommand: false,
      input: "C:/skills",
      kind: "local_path",
    },
  },
  {
    basicCheck: "not_checked",
    id: "browser-helper",
    name: "Browser Helper",
    ownership: "agent_builtin",
    path: "C:/skills/browser-helper",
    source: {
      displayTarget: "C:/skills",
      executesCommand: false,
      input: "C:/skills",
      kind: "local_path",
    },
  },
];

async function renderCandidateSelection(props: Partial<React.ComponentProps<typeof CandidateSelection>> = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <CandidateSelection
        candidates={candidates}
        selectedIds={[]}
        onToggle={vi.fn()}
        {...props}
      />
    </I18nextProvider>,
  );
}

it("warns non-blockingly when a folder name differs from its SKILL.md name", async () => {
  // DEV-3：名称不一致只提示、不拦截导入；一致或缺失 frontmatter 时不提示。
  const mismatched = [
    { ...candidates[0], frontmatterName: "official-pdf-reader" },
    { ...candidates[1], frontmatterName: null },
  ];
  await renderCandidateSelection({ candidates: mismatched });

  expect(screen.getByText(/Folder name differs from the name declared in SKILL.md/)).toBeVisible();
  expect(screen.getAllByText(/Folder name differs/)).toHaveLength(1);
});

it("emits an explicit toggle for each candidate", async () => {
  const onToggle = vi.fn();
  await renderCandidateSelection({ onToggle });

  fireEvent.click(screen.getByRole("checkbox", { name: "PDF Reader" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Browser Helper" }));

  expect(onToggle).toHaveBeenNthCalledWith(1, "pdf-reader");
  expect(onToggle).toHaveBeenNthCalledWith(2, "browser-helper");
});

// “继续前必须先选择候选”的门槛语义已上移到向导底部操作区，
// 由 ImportWizard.test.tsx 的“requires a candidate selection before analyzing”覆盖。

it("supports selecting every discovered candidate in one explicit step", async () => {
  const onSelectAll = vi.fn();
  await renderCandidateSelection({ onSelectAll });

  fireEvent.click(screen.getByRole("button", { name: "Select all importable candidates" }));

  expect(onSelectAll).toHaveBeenCalledOnce();
});

// ---- 第 24 节：候选行安全分级徽标（数据存在时展示，按级别着色） ----

it("shows a security grade badge on each graded candidate row", async () => {
  await renderCandidateSelection({
    securityLevels: {
      "pdf-reader": { level: "danger", dangerCount: 1, warningCount: 0, findings: [] },
      "browser-helper": { level: "pass", dangerCount: 0, warningCount: 0, findings: [] },
    },
  });

  expect(screen.getByText("Danger")).toBeVisible();
  expect(screen.getByText("Pass")).toBeVisible();
});

it("omits the security badge when the candidate has no grading data", async () => {
  await renderCandidateSelection({
    securityLevels: {
      "pdf-reader": { level: "warning", dangerCount: 0, warningCount: 1, findings: [] },
    },
  });

  expect(screen.getByText("Warning")).toBeVisible();
  expect(screen.queryByText(/^Pass$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Danger$/)).not.toBeInTheDocument();
});

it("shows no security badges at all when grading data is absent", async () => {
  await renderCandidateSelection();

  expect(screen.queryByText(/^Danger$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Warning$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Pass$/)).not.toBeInTheDocument();
});

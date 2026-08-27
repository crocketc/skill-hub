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
        onContinue={vi.fn()}
        onBack={vi.fn()}
        {...props}
      />
    </I18nextProvider>,
  );
}

it("emits an explicit toggle for each candidate", async () => {
  const onToggle = vi.fn();
  await renderCandidateSelection({ onToggle });

  fireEvent.click(screen.getByRole("checkbox", { name: "PDF Reader" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Browser Helper" }));

  expect(onToggle).toHaveBeenNthCalledWith(1, "pdf-reader");
  expect(onToggle).toHaveBeenNthCalledWith(2, "browser-helper");
});

it("requires a selection before continuing", async () => {
  const onContinue = vi.fn();
  const i18n = await createSkillHubI18n(["en-US"]);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CandidateSelection
        candidates={candidates}
        selectedIds={[]}
        onToggle={vi.fn()}
        onContinue={onContinue}
        onBack={vi.fn()}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "PDF Reader" }));
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <CandidateSelection
        candidates={candidates}
        selectedIds={["pdf-reader"]}
        onToggle={vi.fn()}
        onContinue={onContinue}
        onBack={vi.fn()}
      />
    </I18nextProvider>,
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
});

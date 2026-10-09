import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type {
  PreparedUsageChange,
  UsageChangeResult,
  UsageRelationView,
} from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { UndeployDialog } from "./UndeployDialog";

const entry = (directoryId: string) => ({
  directory_id: directoryId,
  relative_entry_path: "skills/reviewer",
});

function usageRelation(
  relationId: string,
  kind: UsageRelationView["target"]["kind"],
  form: UsageRelationView["form"],
  directoryId: string,
): UsageRelationView {
  return {
    relation_id: relationId,
    skill_id: "skill-reviewer",
    target: {
      kind,
      directory_id: directoryId,
      agent_client_id: kind === "agent" ? `agent-${directoryId}` : null,
      directory_role: kind === "project" ? "project" : "agent_user",
      recognition: "supported",
    },
    entry_key: entry(directoryId),
    form,
    management: "managed",
    health_reasons: ["normal"],
    decision: null,
    decision_history_ids: [],
    active: true,
    file_representation: form === "link" ? "symbolic_link" : "copy",
    link_target_path: form === "link" ? "/library/reviewer" : null,
    link_target_path_key: null,
    link_target_directory_id: null,
    physical_source_ids_evidence: [`physical-${directoryId}`],
    evidence_relation_ids: [relationId],
  };
}

function preparedUsageChange(overrides: Partial<PreparedUsageChange> = {}): PreparedUsageChange {
  return {
    operation_id: "release-operation-1",
    prepared_id: "prepared-release-1",
    action: "release",
    relationship_revision: "revision-1",
    affected_skill_ids: ["skill-reviewer"],
    subject_versions: [],
    entry_evidence: [],
    consumers: [],
    impacts: [],
    limitations: [],
    ...overrides,
  };
}

function usageChangeResult(itemResults: UsageChangeResult["item_results"]): UsageChangeResult {
  return {
    operation_id: "release-operation-1",
    prepared_id: "prepared-release-1",
    item_results: itemResults,
    recovery_required: false,
  };
}

async function renderDialog(props: Record<string, unknown>) {
  const i18n = await createSkillHubI18n(["en-US"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <UndeployDialog
        candidates={[]}
        onCancel={vi.fn()}
        onCommit={vi.fn().mockResolvedValue(usageChangeResult([]))}
        onPrepare={vi.fn().mockResolvedValue(preparedUsageChange())}
        scope={{ kind: "skill", skillId: "skill-reviewer" }}
        {...props}
      />
    </I18nextProvider>,
  );
}

it("reclaim_groups_are_agent_shared_project", async () => {
  await renderDialog({
    candidates: [
      usageRelation("agent-relation", "agent", "link", "agent-dir"),
      usageRelation("shared-relation", "shared_directory", "full_copy", "shared-dir"),
      usageRelation("project-relation", "project", "link", "project-dir"),
    ],
  });

  expect(screen.getByRole("group", { name: "Agent" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Shared directory" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Project" })).toBeVisible();
});

it("builtin_read_only_entries_are_never_reclaimable_even_when_unhealthy", async () => {
  const builtin = usageRelation("builtin-relation", "agent", "link", "builtin-dir");
  builtin.target.directory_role = "builtin";
  builtin.health_reasons = ["file_missing"];
  await renderDialog({ candidates: [builtin] });

  expect(screen.queryByRole("checkbox", { name: /Agent/ })).not.toBeInTheDocument();
  expect(within(screen.getByRole("group", { name: "Agent" })).getByText("No releasable entries in this group.")).toBeVisible();
});

it("link_has_no_keep_copy_choice", async () => {
  const user = userEvent.setup();
  const onPrepare = vi.fn().mockResolvedValue(preparedUsageChange());
  await renderDialog({
    candidates: [usageRelation("link-relation", "agent", "link", "agent-dir")],
    onPrepare,
  });

  await user.click(screen.getByRole("checkbox", { name: /Agent/ }));
  expect(screen.queryByRole("group", { name: "Copy handling" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Preview release" }));

  await waitFor(() => expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
    copy_disposition: null,
    selected_entry_keys: [entry("agent-dir")],
  })));
});

it("copy_has_keep_and_remove_choices", async () => {
  const user = userEvent.setup();
  await renderDialog({
    candidates: [usageRelation("copy-relation", "shared_directory", "full_copy", "shared-dir")],
  });

  await user.click(screen.getByRole("checkbox", { name: /Shared directory/ }));
  expect(screen.getByRole("radio", { name: "Keep as an independent copy" })).toBeVisible();
  expect(screen.getByRole("radio", { name: "Remove the copy with a backup" })).toBeVisible();
});

it("shared_consumer_is_routed_to_shared_object", async () => {
  const user = userEvent.setup();
  const onPrepare = vi.fn().mockResolvedValue(preparedUsageChange({
    consumers: [{
      relation_ids: ["shared-relation"],
      skill_id: "skill-reviewer",
      entry_key: entry("shared-dir"),
      target: {
        kind: "shared_directory",
        directory_id: "shared-dir",
        agent_client_id: null,
        directory_role: "shared_directory",
        recognition: "supported",
      },
      path: "/shared/skills/reviewer",
      form: "full_copy",
      management: "managed",
      representation: "copy",
      health_reasons: ["normal"],
      physical_source_ids: ["physical-shared"],
      content_fingerprint: "hash-1",
    }],
  }));
  await renderDialog({
    candidates: [usageRelation("shared-relation", "shared_directory", "full_copy", "shared-dir")],
    onPrepare,
  });

  await user.click(screen.getByRole("checkbox", { name: /Shared directory/ }));
  await user.click(screen.getByRole("radio", { name: "Keep as an independent copy" }));
  await user.click(screen.getByRole("button", { name: "Preview release" }));

  await waitFor(() => expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
    relation_ids: [],
    selected_entry_keys: [entry("shared-dir")],
    skill_id: "skill-reviewer",
  })));
  expect(screen.getByTestId("removal-impact-facts")).toHaveTextContent("/shared/skills/reviewer");
});

it("partial_result_is_not_all_success", async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn().mockResolvedValue(usageChangeResult([
    {
      relation_ids: ["agent-relation"],
      skill_id: "skill-reviewer",
      target: { kind: "agent", directory_id: "agent-dir", agent_client_id: "agent-x", directory_role: "agent_user", recognition: "supported" },
      action: "remove_link",
      status: "applied",
      reason: null,
      recovery_point: null,
    },
    {
      relation_ids: ["project-relation"],
      skill_id: "skill-reviewer",
      target: { kind: "project", directory_id: "project-dir", agent_client_id: null, directory_role: "project", recognition: "supported" },
      action: "remove_link",
      status: "failed",
      reason: "permission_denied",
      recovery_point: null,
    },
  ]));
  await renderDialog({
    candidates: [
      usageRelation("agent-relation", "agent", "link", "agent-dir"),
      usageRelation("project-relation", "project", "link", "project-dir"),
    ],
    onCommit,
  });

  await user.click(screen.getByRole("checkbox", { name: /Agent/ }));
  await user.click(screen.getByRole("checkbox", { name: /Project/ }));
  await user.click(screen.getByRole("button", { name: "Preview release" }));
  await user.click(await screen.findByRole("button", { name: "Confirm release" }));

  expect(await screen.findByText("Applied")).toBeVisible();
  expect(screen.getByText("Needs attention")).toBeVisible();
  expect(screen.getByText(/permission_denied/)).toBeVisible();
  expect(screen.queryByText("All uses released")).not.toBeInTheDocument();
});

it("empty_result_is_not_reported_as_success", async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn().mockResolvedValue(usageChangeResult([]));
  await renderDialog({
    candidates: [usageRelation("agent-relation", "agent", "link", "agent-dir")],
    onCommit,
  });

  await user.click(screen.getByRole("checkbox", { name: /Agent/ }));
  await user.click(screen.getByRole("button", { name: "Preview release" }));
  await user.click(await screen.findByRole("button", { name: "Confirm release" }));

  expect(await screen.findByText(/Some entries need attention/)).toBeVisible();
  expect(screen.queryByText(/Usage release complete/)).not.toBeInTheDocument();
});

it("cancel_restores_focus", async () => {
  const user = userEvent.setup();
  const onPrepare = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open reclaim</button>
        {open ? (
          <UndeployDialog
            candidates={[usageRelation("link-relation", "agent", "link", "agent-dir")]}
            onCancel={() => setOpen(false)}
            onCommit={vi.fn()}
            onPrepare={onPrepare}
            scope={{ kind: "skill", skillId: "skill-reviewer" }}
          />
        ) : null}
      </>
    );
  }
  const i18n = await createSkillHubI18n(["en-US"]);
  render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>);

  const trigger = screen.getByRole("button", { name: "Open reclaim" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(trigger).toHaveFocus());
  expect(onPrepare).not.toHaveBeenCalled();
});

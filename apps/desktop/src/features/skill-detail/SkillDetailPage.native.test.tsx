import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import type { RelationGovernanceFacade } from "../relationships/governance/api";
import type { SecurityFacade } from "../security/api";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return {
    ...original,
    executeCommand: vi.fn(),
    queryApplication: vi.fn(),
  };
});

afterEach(() => cleanup());

it("shows a target-fact error and keeps delete confirmation unavailable when impact enrichment fails", async () => {
  vi.mocked(executeCommand).mockResolvedValue({
    type: "removal_impact",
    payload: {
      operation_id: "op-delete",
      skill_id: "skill-pdf",
      deployments: [
        {
          id: "deployment-1",
          skill_id: "skill-pdf",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          target_id: "target-1",
          state: "deployed",
          mode: "managed_copy",
          managed: true,
          runtime_name: "pdf-reader",
          expected_hash: "sha256:tree",
          observed_hash: "sha256:tree",
        },
      ],
      requires_shared_target_choice: false,
      dependencies: [],
      project_configs: [],
      pinned_versions: [],
      combinations: [],
      related_skills: [],
      unknown_external_references: [],
    },
  } as never);
  vi.mocked(queryApplication).mockRejectedValue(new Error("deployment target lookup failed"));

  const governanceFacade = {
    listGovernance: vi.fn().mockResolvedValue({
      rows: [],
      counts: {},
      bucket: "all",
      total: 0,
      relationship_revision: "r1",
      last_verified_at: null,
    }),
    listHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 5 }),
  } as unknown as RelationGovernanceFacade;
  const securityFacade: SecurityFacade = {
    getChecks: async () => [],
    listFindings: async () => [],
    setFindingDisposition: async () => undefined,
    getPreferences: async () => ({ llmProvider: "local-model", dataScope: "explicit_selection" }),
    runBasicCheck: async () => undefined,
    runLlmCheck: async () => undefined,
  };
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/library/skill-pdf"]}>
          <Routes>
            <Route
              element={
                <SkillDetailPage
                  facade={createMockSkillDetailFacade()}
                  governanceFacade={governanceFacade}
                  markdownFacade={createMockMarkdownFacade()}
                  securityFacade={securityFacade}
                />
              }
              path="/library/:skillId"
            />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Delete from library" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Deployment target details could not be verified, so deletion was not prepared.");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm deletion from library" })).not.toBeInTheDocument();
});

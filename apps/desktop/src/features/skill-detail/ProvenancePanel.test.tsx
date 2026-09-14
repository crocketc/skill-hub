import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { SkillObservedDeployment, SkillProvenance } from "./api";
import { ProvenancePanel } from "./ProvenancePanel";

const provenance: SkillProvenance["provenance"] = {
  agentClientId: "trae.code",
  contentFingerprint: "sha256:aa11",
  importedAt: "1700000000",
  originalPath: "/agents/trae/skills/demo",
  ownership: "known_agent_target",
  sourceKind: "local",
  sourceLocator: "/agents/trae/skills/demo",
};

const observed: SkillObservedDeployment[] = [
  {
    clientId: "trae.code",
    contentFingerprint: "sha256:aa11",
    id: "obs-1",
    matchState: "content_verified",
    observedAt: "1700000100",
    originalPath: "/agents/trae/skills/demo",
    origin: "import",
    releasedAt: null,
    status: "active",
  },
  {
    clientId: "trae.code",
    contentFingerprint: "sha256:ff22",
    id: "obs-2",
    matchState: "diverged",
    observedAt: "1700000200",
    originalPath: "/agents/trae/skills/old",
    origin: "scan",
    releasedAt: "1700000300",
    status: "released",
  },
];

async function renderPanel(
  provenance: SkillProvenance["provenance"],
  rows: SkillObservedDeployment[],
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <ProvenancePanel observedDeployments={rows} provenance={provenance} />
    </I18nextProvider>,
  );
}

it("renders complete provenance facts and observed deployment annotations", async () => {
  await renderPanel(provenance, observed);

  expect(screen.getByTestId("import-provenance")).toBeVisible();
  expect(screen.getByText("本地目录")).toBeVisible();
  expect(screen.getAllByText("/agents/trae/skills/demo").length).toBeGreaterThan(0);
  expect(screen.getByText("已知 Agent 目录")).toBeVisible();
  // 关系逐条展示：已验证 + 观察中、已分叉 + 已收回，都标注不冒充。
  expect(screen.getAllByTestId("observed-deployment")).toHaveLength(2);
  expect(screen.getByText("内容一致")).toBeVisible();
  expect(screen.getByText("观察中")).toBeVisible();
  expect(screen.getByText("内容已分叉")).toBeVisible();
  expect(screen.getByText("已收回")).toBeVisible();
});

it("marks unknown attribution honestly instead of guessing", async () => {
  await renderPanel(
    provenance === null ? null : { ...provenance, agentClientId: null },
    [],
  );

  expect(screen.getByText("未识别（无目录证据，不猜测）")).toBeVisible();
  expect(screen.getByTestId("observed-absent")).toBeVisible();
});

it("shows the honest absent state for skills imported without provenance", async () => {
  await renderPanel(null, []);

  expect(screen.getByTestId("provenance-absent")).toBeVisible();
  expect(
    screen.getByText(/不是经由带存证的导入链路进入集中库/),
  ).toBeVisible();
  expect(screen.queryByTestId("import-provenance")).not.toBeInTheDocument();
});

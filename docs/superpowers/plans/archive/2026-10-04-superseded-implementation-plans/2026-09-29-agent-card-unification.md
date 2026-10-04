# Agent Card Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent directory identity and card behavior consistent across backend and frontend entry points through additive facts and adapters, while keeping existing flows and contracts working during migration.

**Architecture:** Keep the existing `AgentCardModel` and current queries as the compatibility base. Add one backend directory projection over existing discovery facts, enrich the current model with the missing member and capability data, and migrate consumers one at a time through thin adapters. Preserve old facades and query outputs until each consumer has moved; avoid unrelated cleanup or file restructuring.

**Tech Stack:** Rust, Tauri 2, Specta-generated TypeScript bindings, React, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-agent-card-unification-design.md`

## Global Constraints

- Keep the current discovery, onboarding, deployment, and project workflows; additions must preserve existing callers while each consumer migrates.
- The projection expresses domain facts and stable identity; it does not contain localized copy, icons, UI order, or JSX/CSS.
- Verified physical identity is authoritative for existing directories; unverified candidates remain explicitly unverified.
- One shared directory is one independent entity; recognized brands/types are associations on that entity.
- A merged card preserves all underlying logical member targets and member-level capabilities.
- Backend commands continue validating capability, permission, path state, and user confirmation for every member target.
- Technical IDs remain internal and never appear in user-visible labels, helper copy, or accessible names.
- Rust structures are the contract source; update TypeScript through the binding generator.
- Windows and macOS path identity, case sensitivity, separators, access errors, links, and junctions require coverage.
- Do not delete existing builders, facades, or query variants as part of this work; compatibility cleanup requires a separate request.

## Review Focus

- Same brand and verified physical directory with multiple kinds: one card, all kinds, every member ID remains selectable. Test in Tasks 2–3 and each consumer adapter.
- Shared directory recognized by multiple brands, including an unrecognized root: exactly one shared entity with only recognized associations. Test in Tasks 2–3 and all selectors.
- Same candidate path text under different roots before physical identity verification: do not merge unless the backend supplies the same candidate identity. Test in Task 2.
- Merged members with different deployment modes or availability: never imply a mode is valid for every member when only some support it. Test in Tasks 2–3 and deployment migration.
- Missing, inaccessible, non-directory, or broken-link destinations: keep the existing state, require confirmation before creating a missing directory, and reobserve identity after creation. Test in Task 2 and selector migrations.

---

### Task 1: Move the compatibility fieldset title above its top border

**Files:**
- Modify: `apps/desktop/src/features/onboarding/onboarding.css`
- Test: `tests/e2e/onboarding-preview.spec.ts`

**Interfaces:**
- Consumes: Existing `.sh-onboarding__targets > legend` styling.
- Produces: The title is vertically above and clear of the fieldset top rule. The line remains visible; no background mask, border, color, card, spacing, grid, or scroll redesign is introduced.

- [ ] **Step 1: Add a browser geometry assertion**

In the onboarding preview compatibility test, measure the legend and fieldset top edge at the existing desktop and narrow viewport cases. Assert that the legend clears the top rule by at least 2 CSS pixels and that the fieldset border remains rendered.

- [ ] **Step 2: Run the focused browser test and confirm the current layout fails**

Run: `pnpm test:e2e tests/e2e/onboarding-preview.spec.ts --grep "path cards in multiple columns"`

Expected: The geometry assertion fails against the current title position.

- [ ] **Step 3: Adjust only the legend's vertical position**

Update `.sh-onboarding__targets > legend` in `onboarding.css` with a relative vertical offset. Do not change its background, the fieldset border, outer padding, grid rows, or neighboring layout.

- [ ] **Step 4: Run the focused browser test**

Run: `pnpm test:e2e tests/e2e/onboarding-preview.spec.ts --grep "path cards in multiple columns"`

Expected: The title clears the border at both viewports; card positions, scrolling, and visible border remain unchanged.

- [ ] **Step 5: Commit**

Run `git diff --check`, then commit only this task with `Fix compatibility target legend position`.

### Task 2: Add the backend directory projection without replacing current queries

**Files:**
- Modify: `crates/skillhub-core/src/agent/discovery.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Modify: `crates/skillhub-core/src/api/mod.rs`
- Modify: `crates/skillhub-core/src/lib.rs`
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade_builtin_directories.rs`
- Test: `crates/skillhub-application/tests/facade.rs`
- Test: generated bindings via `crates/skillhub-desktop` binding generator

**Interfaces:**
- Consumes: Existing discovery snapshot, Agent root observations, logical/physical targets, and existing deployment target capability facts.
- Produces: An additive `GetAgentDirectoryProjection` query returning `AgentDirectoryProjection { directories: Vec<AgentDirectoryFact> }`. Each fact contains role/status/path identity and member facts (brand, kind, logical target ID, availability, and member-scoped deployment capabilities). Existing query/command variants and persistence formats remain available.

- [ ] **Step 1: Add failing application facade tests**

Add tests for same-path/different-kind members, different physical paths of one brand, one shared directory with only root-identified brands, unverified candidate identity, and mixed per-member modes. Assert complete member/capability facts.

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cargo test -p skillhub-application --test facade_builtin_directories agent_directory_projection`

Expected: The additive projection query/types are absent.

- [ ] **Step 3: Add the additive core projection contract and query**

Define serializable, `specta::Type` projection structs and `GetAgentDirectoryProjection`. Keep display copy and visual choices out of the Rust contract. Include explicit candidate identity for unverified/missing directories and per-member capability values rather than a flattened union.

- [ ] **Step 4: Build the projection from existing authoritative facts**

Add one application helper over current discovery and deployment facts. Group verified directories by physical identity; use candidate identity only for unverified targets. Keep the shared directory canonical and attach only root-identified brand/kind associations. Do not rewrite existing queries or persisted snapshot formats.

- [ ] **Step 5: Run projection facade tests**

Run: `cargo test -p skillhub-application --test facade_builtin_directories --test facade`

Expected: Existing tests and the new projection tests pass.

- [ ] **Step 6: Generate TypeScript bindings**

Run in PowerShell: `$env:SKILLHUB_WRITE_BINDINGS='1'; cargo test -p skillhub-desktop generate_bindings`

Expected: Generated bindings contain the additive query/projection; no hand-edited duplicate contract.

- [ ] **Step 7: Commit**

Run `git diff --check`, then commit only the new projection contract/helper/bindings with `Add Agent directory projection query`.

### Task 3: Extend the existing AgentCardModel while keeping compatibility adapters

**Files:**
- Modify: `apps/desktop/src/features/agents/api.ts`
- Modify: `apps/desktop/src/features/agents/agentCardModel.ts`
- Modify: `apps/desktop/src/features/agents/agentCards.ts`
- Modify: `apps/desktop/src/features/agents/nativeApi.ts`
- Modify: `apps/desktop/src/features/agents/agentCardModel.test.ts`
- Modify: `apps/desktop/src/features/agents/agentCards.test.ts`
- Modify: `apps/desktop/src/ui/AgentPresentation.tsx`

**Interfaces:**
- Consumes: Generated `AgentDirectoryProjection` from Task 2.
- Produces: Additive `buildAgentDirectoryCardModels(projection) -> AgentCardModel[]` and projection-to-existing-`AgentView` adapter. Keep current `buildAgentCardModels(AgentView[])`, `buildAgentCardViews`, and current facades operational for unmigrated consumers.

- [ ] **Step 1: Add failing model tests**

Assert verified physical identity wins over path spelling; candidate identities do not cross-merge; a shared directory is unique with recognized brands only; all kinds and member target IDs survive; pending/inaccessible/broken-link/builtin/project roles remain explicit; and mixed supported modes are not flattened into universal support.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --dir apps/desktop exec vitest run src/features/agents/agentCardModel.test.ts src/features/agents/agentCards.test.ts`

Expected: New projection behavior fails because the current input path loses some identity/member facts and mode merging uses a union.

- [ ] **Step 3: Add the projection adapter to the current model**

Implement `buildAgentDirectoryCardModels` by adapting the generated projection into the existing `AgentCardModel` structure. Preserve the old builder as-is for existing callers until migrated. Keep each member's target/capability fact available; only expose a card-wide mode as supported when every selectable member supports it.

- [ ] **Step 4: Add the shared-directory presenter assertions**

Assert one independent shared-directory presentation, recognized brand logos with mapped type labels, and no technical identifiers in visible or accessible names.

- [ ] **Step 5: Run focused model/presenter tests**

Run: `pnpm --dir apps/desktop exec vitest run src/features/agents/agentCardModel.test.ts src/features/agents/agentCards.test.ts src/ui/AgentPresentation.test.tsx`

Expected: Existing Agent list model behavior and new projection behavior pass together.

- [ ] **Step 6: Commit**

Run `git diff --check`, then commit with `Extend Agent card model with directory facts`.

### Parallel migration phase

Start this phase only after Tasks 1–3 are committed and their public interfaces are stable. Give each workstream a separate worktree from the same integration commit. Do not edit shared E2E spec files in these worktrees; add unit/component tests locally and leave cross-entry browser parity to Task 8. Preserve current facades and screens while adding adapters; do not perform unrelated cleanup.

### Task 4: Adapt initialization and rescan compatibility cards

**Files:**
- Modify: `apps/desktop/src/features/bootstrap/api.ts`
- Modify: `apps/desktop/src/features/onboarding/CompatibilityStep.tsx`
- Modify: `apps/desktop/src/features/onboarding/OnboardingWizard.tsx`
- Modify: `apps/desktop/src/features/onboarding/RescanWizard.tsx`
- Modify: `apps/desktop/src/features/onboarding/CompatibilityStep.test.tsx`
- Modify: `apps/desktop/src/features/onboarding/RescanWizard.test.tsx`

**Interfaces:**
- Consumes: Additive projection query and `buildAgentDirectoryCardModels` from Tasks 2–3.
- Produces: Both flows render canonical directory cards while retaining existing discovery/scan operations, confirmation, progress, background handoff, and selected scope IDs.

- [ ] **Step 1: Add failing shared-directory and member-selection tests**

Assert one shared card from multiple identified brands, no card for an unrecognized root, one merged card for same brand/path kinds, distinct cards for distinct physical paths, and selecting a card expands to every represented logical scope exactly once.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --dir apps/desktop exec vitest run src/features/onboarding/CompatibilityStep.test.tsx src/features/onboarding/RescanWizard.test.tsx`

Expected: The current reduced `CompatibilityTarget` conversion cannot represent shared membership and physical identity.

- [ ] **Step 3: Add the projection adapter without changing wizard flow**

Have initialization and rescan read the additive projection and pass the results through the existing card layout. Keep the existing scan command and target-selection callbacks; change only the card grouping input and member-to-scope mapping.

- [ ] **Step 4: Run focused wizard tests**

Run: `pnpm --dir apps/desktop exec vitest run src/features/onboarding/CompatibilityStep.test.tsx src/features/onboarding/RescanWizard.test.tsx src/features/onboarding/OnboardingWizard.test.tsx`

Expected: Existing confirmation, cancellation, scan progress, and background handoff tests pass with the new card grouping assertions.

- [ ] **Step 5: Commit**

Run `git diff --check`, then commit with `Adapt onboarding to shared Agent cards`.

### Task 5: Adapt discovery workbench cards

**Files:**
- Modify: `apps/desktop/src/features/discovery/api.ts`
- Modify: `apps/desktop/src/features/discovery/LocalDiscoveryWorkbench.tsx`
- Modify: `apps/desktop/src/features/discovery/api.test.ts`
- Modify: `apps/desktop/src/features/discovery/LocalDiscoveryWorkbench.test.tsx`

**Interfaces:**
- Consumes: `AgentDirectoryProjection` and `buildAgentDirectoryCardModels` from Tasks 2–3.
- Produces: Existing available/unavailable sections and ignore-rule actions over canonical card identities. This screen may filter/sort after projection but does not regroup paths or synthesize shared brands.

- [ ] **Step 1: Add failing discovery parity tests**

Assert the discovery workbench uses the same directory identities, type sets, shared brands, and statuses as Agent cards, including Windows separator/case variants and unrecognized shared roots.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --dir apps/desktop exec vitest run src/features/discovery/api.test.ts src/features/discovery/LocalDiscoveryWorkbench.test.tsx`

Expected: The independent `buildAgentGroups` implementation disagrees with projection card membership/presentation.

- [ ] **Step 3: Adapt existing discovery grouping to the shared card model**

Keep `buildAgentGroups` as a compatibility wrapper that filters and sorts shared models by the current availability sections. Preserve scan, exclusion, builtin label, and path rendering behavior.

- [ ] **Step 4: Run focused discovery tests**

Run: `pnpm --dir apps/desktop exec vitest run src/features/discovery/api.test.ts src/features/discovery/LocalDiscoveryWorkbench.test.tsx`

Expected: Existing discovery behavior and new parity assertions pass.

- [ ] **Step 5: Commit**

Run `git diff --check`, then commit with `Adapt discovery cards to shared model`.

### Task 6: Adapt batch deployment destination cards

**Files:**
- Modify: `apps/desktop/src/features/deployment/api.ts`
- Modify: `apps/desktop/src/features/deployment/nativeApi.ts`
- Modify: `apps/desktop/src/features/deployment/BatchDeploymentPage.tsx`
- Modify: `apps/desktop/src/features/deployment/DeploymentTargetPresentation.tsx`
- Modify: `apps/desktop/src/features/deployment/BatchDeploymentPage.test.tsx`
- Modify: `apps/desktop/src/features/deployment/nativeApi.test.ts`

**Interfaces:**
- Consumes: Existing `list_deployment_targets` response plus the additive directory projection and shared card model.
- Produces: A displayed card per canonical directory with member logical target IDs preserved for preview/commit. Existing deployment preview/commit payloads continue using their existing target IDs; no card ID is used as an authorization or destination identity.

- [ ] **Step 1: Add failing grouped-target tests**

Assert same brand/path targets with different kinds display once and preserve all target IDs; distinct physical directories remain separate; shared directory remains canonical; and unsupported member modes cannot be submitted through the card.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --dir apps/desktop exec vitest run src/features/deployment/BatchDeploymentPage.test.tsx src/features/deployment/nativeApi.test.ts`

Expected: The current page renders per-target cards and only one client kind.

- [ ] **Step 3: Group only the display projection and retain existing write flow**

Create card groups from the shared model, map selected cards back to existing deployment target IDs, and keep per-member modes/status. For an explicit group-wide mode, enable it only if every selectable member supports it; keep automatic mode behavior unchanged and let current backend planning decide each member.

- [ ] **Step 4: Run focused deployment tests**

Run: `pnpm --dir apps/desktop exec vitest run src/features/deployment/BatchDeploymentPage.test.tsx src/features/deployment/nativeApi.test.ts`

Expected: Selection expansion, mode constraints, existing pair preview, exclusions, and commit behavior pass.

- [ ] **Step 5: Commit**

Run `git diff --check`, then commit with `Adapt deployment selection to shared Agent cards`.

### Task 7: Adapt project Agent association cards

**Files:**
- Modify: `apps/desktop/src/features/projects/api.ts`
- Modify: `apps/desktop/src/features/projects/nativeApi.ts`
- Modify: `apps/desktop/src/features/projects/ProjectListPage.tsx`
- Modify: `apps/desktop/src/features/projects/ProjectDetailPage.tsx`
- Modify: `apps/desktop/src/features/projects/ProjectListPage.test.tsx`
- Modify: `apps/desktop/src/features/projects/ProjectDetailPage.test.tsx`
- Modify: `apps/desktop/src/features/projects/nativeApi.test.ts`

**Interfaces:**
- Consumes: Additive directory projection and shared card model from Tasks 2–3.
- Produces: Grouped project candidate cards with association selection mapped to existing project Agent IDs. The persisted project association contract and update flow remain unchanged.

- [ ] **Step 1: Add failing association tests**

Assert same brand/path kinds merge, shared directory appears once, distinct paths remain separate, partial groups show a mixed checkbox state, and saving/reloading preserves all selected associations.

- [ ] **Step 2: Run focused project tests and confirm failure**

Run: `pnpm --dir apps/desktop exec vitest run src/features/projects/ProjectListPage.test.tsx src/features/projects/ProjectDetailPage.test.tsx src/features/projects/nativeApi.test.ts`

Expected: Current selectors show one checkbox per logical target and do not carry complete member/kind groups.

- [ ] **Step 3: Adapt candidates and keep existing persistence mapping**

Use the shared model for both project registration and detail association. A group is checked when all members are selected, unchecked when none are selected, and indeterminate when only some are selected. Toggling selects or clears the group members while saving the existing IDs.

- [ ] **Step 4: Run focused project tests**

Run: `pnpm --dir apps/desktop exec vitest run src/features/projects/ProjectListPage.test.tsx src/features/projects/ProjectDetailPage.test.tsx src/features/projects/nativeApi.test.ts`

Expected: Existing register/edit/save behavior passes with grouped cards and round-trip member selections.

- [ ] **Step 5: Commit**

Run `git diff --check`, then commit with `Adapt project selectors to shared Agent cards`.

### Follow-up: Adapt the native Agent list to the canonical projection

**Reason:** Final cross-consumer review found that `/agents` still consumed the legacy `AgentView[]` builder after Tasks 4–7 had moved their selectors to projected directory facts. The legacy mode union could overstate support when members sharing a directory had different capabilities.

**Files:** `apps/desktop/src/features/agents/AgentListPage.tsx`, `apps/desktop/src/features/agents/nativeApi.ts`, `apps/desktop/src/features/agents/api.ts`, and their colocated tests.

- Add failing facade/UI tests proving the page prefers canonical card models, expands a member back to its detail route, and uses the intersection of available-member modes.
- Add `listCardModels()` as an optional additive facade path. The native implementation reads the directory projection and current custom-Agent facts; legacy `list()` remains for compatibility previews and existing tests.
- Preserve custom Agent handling and existing detail routes; make no page-layout rewrite.
- Run focused Vitest, `pnpm check:frontend`, and `git diff --check` before committing.

### Task 8: Audit remaining Agent identity presentations without redesigning their screens

**Files:**
- Inspect: `apps/desktop/src/features/skills/AgentDeploymentIcons.tsx`, `apps/desktop/src/features/skills/SkillMatrix.tsx`, `apps/desktop/src/features/skill-detail/RelationsPanel.tsx`, `apps/desktop/src/features/skill-detail/ProvenancePanel.tsx`, `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`, `apps/desktop/src/features/relationships/graph/SkillGraphCanvas.tsx`, `apps/desktop/src/features/relationships/graph/GraphDetailsPanel.tsx`, `apps/desktop/src/features/relationships/governance/GovernanceRelationTable.tsx`, `apps/desktop/src/features/relationships/governance/GovernanceHistoryTable.tsx`, `apps/desktop/src/features/relationshipGovernance/RelationshipRemovalImpactView.tsx`, `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.tsx`, `apps/desktop/src/features/removal/RemovalImpactPieces.tsx`, `apps/desktop/src/features/import/ImportSummary.tsx`, and `apps/desktop/src/features/overview/DeploymentBarChart.tsx`.
- Inspect only (modify only if the existing mapping is incorrect): `apps/desktop/src/ui/AgentPresentation.tsx`.
- Tests: `apps/desktop/src/features/skills/AgentDeploymentIcons.test.tsx`, `apps/desktop/src/features/skills/SkillLibraryPage.test.tsx`, `apps/desktop/src/features/relationships/graph/SkillGraphCanvas.test.tsx`, `apps/desktop/src/features/relationships/graph/GraphDetailsPanel.test.tsx`, `apps/desktop/src/features/relationships/governance/GovernanceHistoryPage.test.tsx`, `apps/desktop/src/features/relationships/governance/RelationshipGovernancePage.test.tsx`, `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`, `apps/desktop/src/features/skill-detail/RelationsPanel.test.tsx`, `apps/desktop/src/features/skill-detail/ProvenancePanel.test.tsx`, `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`, `apps/desktop/src/features/skills/BatchRemovalDrawer.test.tsx`, `apps/desktop/src/features/import/ImportSummary.test.tsx`, `apps/desktop/src/features/overview/DeploymentBarChart.test.tsx`, and `apps/desktop/src/ui/AgentPresentation.test.tsx`.

**Interfaces:**
- Consumes: Existing presenters and the additive member/brand/kind facts from Tasks 2–3.
- Produces: Existing detail, graph, governance, import, removal, and overview layouts continue unchanged while authoritative user-readable brand/type facts are supplied wherever available. Card-like selectors are handled in Tasks 4–7; this task does not turn identity labels into new cards.

- [ ] **Step 1: Inventory and classify all listed consumers**

Run: `rg -n "AgentPresentation|AgentIdentity|AgentKindBadge|client_id|agent_client_id" apps/desktop/src --glob '*.tsx' --glob '*.ts'`

Classify each hit as a selector/card, identity label, graph node, or internal mapping. Confirm every selector is already covered by Tasks 4–7.

- [ ] **Step 2: Add failing tests only for actual gaps**

For each listed surface lacking authoritative kinds, assert brand plus mapped type and no raw ID in visible/accessibility names. In graph tests, assert the shared-directory intermediate node and edges remain intact.

- [ ] **Step 3: Pass missing facts through existing presenters**

Change only adapter props/data mapping for consumers that currently infer from IDs despite authoritative facts being available. Leave correct `AgentPresentation` consumers and all existing page layouts untouched.

- [ ] **Step 4: Run focused consumer tests**

Run the named colocated test files listed above, omitting a file only when its owning component is not changed.

Expected: Changed identity surfaces use authoritative display kinds; graph topology and unaffected page layouts remain unchanged.

- [ ] **Step 5: Commit**

Run `git diff --check`, then commit the narrowly changed adapters/tests with `Preserve Agent identity across detail views`.

### Task 9: Cross-entry parity, platform coverage, and development handoff

**Files:**
- Modify: `tests/e2e/agents-projects-preview.spec.ts`
- Modify: `tests/e2e/discovery-cards.spec.ts`
- Modify: `tests/e2e/onboarding-preview.spec.ts`
- Modify: `tests/e2e/workflow-deployment.spec.ts`
- Modify: deterministic Agent/project/discovery preview fixtures only where their facades still use obsolete identity labels or omit the directory projection
- Modify: `docs/development/开发状态-2026-09-29.md`
- Modify: `docs/development/自动化测试说明-2026-09-29.md`
- Modify: `docs/development/功能完成度与验收状态矩阵-2026-09-29.md`
- Modify: `docs/development/人工验收清单-2026-09-29.md`

**Interfaces:**
- Consumes: All additive adapters from Tasks 2–8.
- Produces: Cross-entry parity evidence from equivalent deterministic facts in each existing preview (the previews are independent fixtures, so they do not claim to be one shared runtime fixture); current docs distinguish code/automation status from real Windows/macOS desktop evidence.

- [ ] **Step 1: Add failing end-to-end parity coverage**

Add representative parity assertions without joining the preview architectures: Agent list verifies a canonical model response and retains a member detail route; initialization/rescan verifies same-path OpenAI kinds merge once while another physical path remains separate; discovery verifies one shared directory card and only recognized brand/type associations; project selection uses readable brand/type names and preserves grouped member selection; deployment keeps the shared card model's member capability constraints in its existing E2E suite. Keep deterministic fixtures local to their current preview facades.

- [ ] **Step 2: Run targeted E2E and confirm old entry points disagree**

Run: `pnpm test:e2e tests/e2e/agents-projects-preview.spec.ts tests/e2e/discovery-cards.spec.ts tests/e2e/onboarding-preview.spec.ts tests/e2e/relationship-views.spec.ts tests/e2e/workflow-deployment.spec.ts`

Expected: New parity assertions fail before all consumer adapters are applied.

- [ ] **Step 3: Run front-end, browser, and backend validation**

Run: `pnpm --dir apps/desktop exec vitest run`

Run: `pnpm check:frontend`

Run: `pnpm test:e2e tests/e2e/agents-projects-preview.spec.ts tests/e2e/discovery-cards.spec.ts tests/e2e/onboarding-preview.spec.ts tests/e2e/relationship-views.spec.ts`

Run: `cargo test -p skillhub-core -p skillhub-application -p skillhub-adapters -p skillhub-storage`

Expected: Relevant suites pass; known toolchain/watcher limits are reported accurately, not converted to passes.

- [ ] **Step 4: Update the complete-operation manual acceptance flow**

Extend the current Agent workflow to compare all migrated surfaces from one controlled discovery fixture, record OS/build/window evidence, and include cleanup. Do not record manual pass before a real desktop run.

- [ ] **Step 5: Update current development documents**

Record completed code and automation separately from still-needed Windows/macOS desktop verification in the three current state/automation/matrix documents; update the human checklist with the complete cross-entry flow.

- [ ] **Step 6: Commit**

Run `git diff --check`, verify no personal paths or Skill contents entered the docs, then commit with `Verify Agent cards across entry points`.

## Parallel Execution Boundaries

- Tasks 1–3 are sequential because consumer work depends on the shared contract/model.
- Tasks 4–7 are independent once Task 3 is committed. Run each in a separate worktree from the same base commit, up to the available three worker slots at once; run another wave after a slot frees. Do not let worktrees modify the same E2E files; Task 9 owns cross-entry E2E changes.
- Task 8 can run alongside Tasks 4–7 after Tasks 2–3, provided it limits edits to the listed identity consumers and colocated tests.
- Task 9 starts after all worktree changes are reviewed and integrated.
- Keep existing APIs/builders during migration. Any later dead-code cleanup is a separate task and is outside this plan.

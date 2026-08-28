import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./AppShell";
import {
  createPreviewAgentFacade,
  createPreviewDeploymentFacade,
  createPreviewImportFacade,
  createPreviewOperationFacade,
  createPreviewPendingFacade,
  createPreviewProjectFacade,
  createPreviewSecurityFacade,
  createPreviewSettingsFacade,
  previewRemovalImpact,
  previewBootstrapSnapshot,
  previewBootstrapRuntime,
  previewOnboardingOperations,
} from "./previewFixtures";

const links = [
  ["/onboarding", "初始化"],
  ["/", "概览"],
  ["/library", "技能库"],
  ["/discovery", "发现与导入"],
  ["/agents", "Agent"],
  ["/projects", "项目"],
  ["/pending", "待处理"],
  ["/operations/op-preview-42", "操作进度"],
  ["/recovery", "恢复"],
  ["/removal", "删除影响"],
  ["/settings", "设置"],
] as const;

export function PreviewToolbar() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <nav aria-label="Plan07 预览页面" className="sh-preview-toolbar">
      <strong>Plan07 预览</strong>
      <div>
        {links.map(([path, label]) => {
          const target = `/__preview${path === "/" ? "" : path}`;
          const active = location.pathname === target || (path !== "/" && location.pathname.startsWith(target));
          return <button aria-current={active ? "page" : undefined} key={target} onClick={() => navigate(target)} type="button">{label}</button>;
        })}
      </div>
    </nav>
  );
}

export function PreviewShell() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <PreviewToolbar />
      <AppShell snapshot={previewBootstrapSnapshot} verification={{ kind: "unavailable" }} />
    </QueryClientProvider>
  );
}

export function PreviewAgentList() { return <AgentList facade={createPreviewAgentFacade()} />; }
export function PreviewAgentDetail({ id }: { id?: string }) { return <AgentDetail facade={createPreviewAgentFacade()} id={id} />; }
export function PreviewProjectList() { return <ProjectList facade={createPreviewProjectFacade()} />; }
export function PreviewProjectDetail({ id }: { id?: string }) { return <ProjectDetail facade={createPreviewProjectFacade()} id={id} />; }
export function PreviewDiscovery() { return <Discovery facade={createPreviewImportFacade()} />; }
export function PreviewDeployment({ id }: { id?: string }) { return <Deployment facade={createPreviewDeploymentFacade()} id={id} />; }
export function PreviewSecurity({ id }: { id?: string }) { return <Security facade={createPreviewSecurityFacade()} id={id} />; }
export function PreviewPending() { return <Pending facade={createPreviewPendingFacade()} />; }
export function PreviewOperation({ id }: { id?: string }) { return <Operation facade={createPreviewOperationFacade()} id={id} />; }
export function PreviewRecovery() { return <Recovery facade={createPreviewOperationFacade()} />; }
export function PreviewSettings() { return <Settings facade={createPreviewSettingsFacade()} />; }
export function PreviewRemoval() { return <RemovalImpactDialog impact={previewRemovalImpact} onConfirm={() => undefined} />; }
export function PreviewOnboarding() {
  return <OnboardingWizard libraryPath="C:/SkillHub/library" operations={previewOnboardingOperations} runtime={previewBootstrapRuntime} />;
}

import { AgentDetailPage } from "../features/agents/AgentDetailPage";
import { AgentListPage } from "../features/agents/AgentListPage";
import { DeploymentDialog } from "../features/deployment/DeploymentDialog";
import { DiscoveryPage } from "../features/discovery/DiscoveryPage";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";
import { OperationProgress } from "../features/operations/OperationProgress";
import { PendingPage } from "../features/pending/PendingPage";
import { ProjectDetailPage } from "../features/projects/ProjectDetailPage";
import { ProjectListPage } from "../features/projects/ProjectListPage";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { RemovalImpactDialog } from "../features/removal/RemovalImpactDialog";
import { SecurityResults } from "../features/security/SecurityResults";
import { SettingsPage } from "../features/settings/SettingsPage";

function AgentList({ facade }: { facade: ReturnType<typeof createPreviewAgentFacade> }) { return <AgentListPage facade={facade} />; }
function AgentDetail({ facade, id }: { facade: ReturnType<typeof createPreviewAgentFacade>; id?: string }) { return <AgentDetailPage agentId={id} facade={facade} />; }
function ProjectList({ facade }: { facade: ReturnType<typeof createPreviewProjectFacade> }) { return <ProjectListPage facade={facade} />; }
function ProjectDetail({ facade, id }: { facade: ReturnType<typeof createPreviewProjectFacade>; id?: string }) { return <ProjectDetailPage projectId={id} facade={facade} />; }
function Discovery({ facade }: { facade: ReturnType<typeof createPreviewImportFacade> }) { return <DiscoveryPage importFacade={facade} />; }
function Deployment({ facade, id }: { facade: ReturnType<typeof createPreviewDeploymentFacade>; id?: string }) { return <DeploymentDialog facade={facade} skillId={id ?? "skill-pdf"} versionId="v1.4.0" />; }
function Security({ facade, id }: { facade: ReturnType<typeof createPreviewSecurityFacade>; id?: string }) { return <SecurityResults facade={facade} skillId={id ?? "skill-pdf"} versionId="v1.4.0" />; }
function Pending({ facade }: { facade: ReturnType<typeof createPreviewPendingFacade> }) { return <PendingPage facade={facade} />; }
function Operation({ facade, id }: { facade: ReturnType<typeof createPreviewOperationFacade>; id?: string }) { return <OperationProgress facade={facade} operationId={id ?? "op-preview-42"} />; }
function Recovery({ facade }: { facade: ReturnType<typeof createPreviewOperationFacade> }) { return <RecoveryPage facade={facade} operationId="op-preview-42" />; }
function Settings({ facade }: { facade: ReturnType<typeof createPreviewSettingsFacade> }) { return <SettingsPage facade={facade} />; }

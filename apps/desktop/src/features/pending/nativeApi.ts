import { executeCommand, queryApplication, type PendingItem as NativePendingItem } from "../../api/bindings";
import type { PendingFacade, PendingItem } from "./api";

function pendingItem(item: NativePendingItem): PendingItem {
  return {
    id: `${item.kind}:${item.subject}:${item.code}`,
    subject: item.subject,
    kind: item.kind,
    code: item.code,
    message: item.message_code ?? item.code,
  };
}

async function currentVersion(skillId: string): Promise<string> {
  const result = await queryApplication({ type: "get_skill", payload: { skill_id: skillId } });
  if (result.type !== "skill" || !result.payload.current_version) throw new Error("pending item has no current Skill version");
  return result.payload.current_version;
}

export const nativePendingFacade: PendingFacade = {
  async list() {
    const result = await queryApplication({ type: "list_pending_items", payload: null });
    if (result.type !== "pending_items") {
      throw new Error("list_pending_items returned an unexpected native result.");
    }
    return result.payload.map(pendingItem);
  },
  async resolve(item) {
    if (item.kind === "security_finding") {
      const versionId = await currentVersion(item.subject);
      const result = await executeCommand({ type: "set_finding_disposition", payload: { skill_id: item.subject, version_id: versionId, kind: "basic", finding_id: item.code, disposition: "acknowledged", high_risk_confirmed: true } });
      if (result.type !== "basic_check_result") throw new Error("pending resolution returned an unexpected result");
      return;
    }
    if (item.kind === "recovery") {
      await executeCommand({ type: "acknowledge_recovery", payload: { operation_id: item.subject } });
      return;
    }
    await executeCommand({ type: "set_lifecycle", payload: { skill_id: item.subject, lifecycle: "Archived" } });
  },
  async recheck(item) {
    const versionId = await currentVersion(item.subject);
    const result = await executeCommand({ type: "recheck_basic", payload: { skill_id: item.subject, version_id: versionId } });
    if (result.type !== "basic_check_result") throw new Error("pending recheck returned an unexpected result");
  },
  async convert(item) {
    await executeCommand({ type: "set_lifecycle", payload: { skill_id: item.subject, lifecycle: "Normal" } });
  },
  async remove(item) {
    await nativePendingFacade.resolve(item);
  },
  async recover(item) {
    await executeCommand({ type: "acknowledge_recovery", payload: { operation_id: item.subject } });
  },
};

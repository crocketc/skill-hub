import { queryApplication, type PendingItem as NativePendingItem } from "../../api/bindings";
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

function unsupported(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is not connected yet.`));
}

export const nativePendingFacade: PendingFacade = {
  async list() {
    const result = await queryApplication({ type: "list_pending_items", payload: null });
    if (result.type !== "pending_items") {
      throw new Error("list_pending_items returned an unexpected native result.");
    }
    return result.payload.map(pendingItem);
  },
  resolve: () => unsupported("pending_resolve"),
  recheck: () => unsupported("pending_recheck"),
  convert: () => unsupported("pending_convert"),
  remove: () => unsupported("pending_remove"),
  recover: () => unsupported("pending_recover"),
};

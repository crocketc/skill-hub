export type PendingKind = "trial_due" | "security_finding" | "recovery";
export type PendingItem = { id: string; subject: string; kind: PendingKind; message: string };
export interface PendingFacade {
  list(): Promise<PendingItem[]>;
  resolve(item: PendingItem): Promise<void>;
  recheck(item: PendingItem): Promise<void>;
  convert(item: PendingItem): Promise<void>;
  remove(item: PendingItem): Promise<void>;
  recover(item: PendingItem): Promise<void>;
}
const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailablePendingFacade: PendingFacade = {
  list: () => unavailable("pending_list"),
  resolve: () => unavailable("pending_resolve"),
  recheck: () => unavailable("pending_recheck"),
  convert: () => unavailable("pending_convert"),
  remove: () => unavailable("pending_remove"),
  recover: () => unavailable("pending_recover"),
};

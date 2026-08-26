export interface SkillLibraryReturnState {
  focusSkillId: string;
  scrollLeft: number;
  scrollTop: number;
}

export function detailSearchFromLibrary(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("skill");
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function readLibraryReturnState(
  state: unknown,
): SkillLibraryReturnState | undefined {
  if (!state || typeof state !== "object" || !("libraryReturn" in state)) {
    return undefined;
  }
  const value = state.libraryReturn;
  if (!value || typeof value !== "object") return undefined;
  if (!("focusSkillId" in value) || typeof value.focusSkillId !== "string") {
    return undefined;
  }
  if (!("scrollLeft" in value) || !Number.isFinite(value.scrollLeft)) {
    return undefined;
  }
  if (!("scrollTop" in value) || !Number.isFinite(value.scrollTop)) {
    return undefined;
  }
  return {
    focusSkillId: value.focusSkillId,
    scrollLeft: value.scrollLeft as number,
    scrollTop: value.scrollTop as number,
  };
}

import type { CompatibilityStatus, ImportCompatibility } from "../../api/bindings";

export function mergeImportCompatibility(facts: ImportCompatibility[]): ImportCompatibility {
  const common = (mode: keyof ImportCompatibility): CompatibilityStatus =>
    facts.some((fact) => fact[mode] === "unsupported") ? "unsupported"
      : !facts.length || facts.some((fact) => fact[mode] === "unverified") ? "unverified" : "supported";
  return { copy: common("copy"), symlink: common("symlink"), junction: common("junction") };
}

export function linkCompatibility(facts: ImportCompatibility): CompatibilityStatus {
  if (facts.symlink === "supported" || facts.junction === "supported") return "supported";
  if (facts.symlink === "unverified" || facts.junction === "unverified") return "unverified";
  return "unsupported";
}

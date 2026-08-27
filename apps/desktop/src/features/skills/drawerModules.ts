import {
  type DrawerModuleId,
  type DrawerPreset,
  type SkillDrawerPreferences,
} from "./api";

export const REQUIRED_DRAWER_MODULES = [
  "identity",
  "primary_actions",
  "risk_summary",
  "full_details",
] as const;

export const OPTIONAL_DRAWER_MODULES = [
  "relations",
  "versions",
  "source_license",
  "security_checks",
  "invocation_requirements",
  "dependencies_duplicates",
  "external_changes",
  "usage_evidence",
] as const;

export const DRAWER_MODULES: readonly DrawerModuleId[] = [
  ...REQUIRED_DRAWER_MODULES,
  ...OPTIONAL_DRAWER_MODULES,
];

const DRAWER_MODULE_SET = new Set<DrawerModuleId>(DRAWER_MODULES);
const REQUIRED_DRAWER_MODULE_SET = new Set<DrawerModuleId>(
  REQUIRED_DRAWER_MODULES,
);

function normalizeModuleList(values: readonly DrawerModuleId[]) {
  const normalized: DrawerModuleId[] = [];
  const seen = new Set<DrawerModuleId>();
  for (const value of values) {
    if (DRAWER_MODULE_SET.has(value) && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

export function normalizeDrawerPreferences(
  preferences: SkillDrawerPreferences,
): SkillDrawerPreferences {
  const moduleOrder = normalizeModuleList(preferences.moduleOrder);
  for (const moduleId of DRAWER_MODULES) {
    if (!moduleOrder.includes(moduleId)) {
      moduleOrder.push(moduleId);
    }
  }

  const visibleModules = normalizeModuleList(preferences.visibleModules);
  for (const moduleId of REQUIRED_DRAWER_MODULES) {
    if (!visibleModules.includes(moduleId)) {
      visibleModules.push(moduleId);
    }
  }

  return {
    ...preferences,
    moduleOrder,
    visibleModules,
  };
}

export function reorderDrawerModule(
  order: DrawerModuleId[],
  moved: DrawerModuleId,
  before: DrawerModuleId,
): DrawerModuleId[] {
  const next = [...order];
  const movedIndex = next.indexOf(moved);
  const beforeIndex = next.indexOf(before);
  if (movedIndex < 0 || beforeIndex < 0 || moved === before) {
    return next;
  }
  next.splice(movedIndex, 1);
  next.splice(next.indexOf(before), 0, moved);
  return next;
}

export function clampDrawerWidth(widthPx: number, viewportWidth: number): number {
  const maximum = Math.max(420, viewportWidth - 32);
  return Math.min(maximum, Math.max(420, widthPx));
}

export function drawerWidthForPreset(
  preset: DrawerPreset,
  viewportWidth: number,
): number {
  const width =
    preset === "standard"
      ? 480
      : preset === "wide"
        ? 680
        : viewportWidth - 48;
  return clampDrawerWidth(width, viewportWidth);
}

export function isRequiredDrawerModule(
  moduleId: DrawerModuleId,
): boolean {
  return REQUIRED_DRAWER_MODULE_SET.has(moduleId);
}

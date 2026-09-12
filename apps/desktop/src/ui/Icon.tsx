import type { ReactNode, SVGProps } from "react";

/**
 * Local functional icon registry. Drawn on a 24×24 grid with 1.75–2px
 * strokes, round caps, and `currentColor`. Original artwork shipped with
 * this repository (same license as the codebase); brand logos live in the
 * separate BrandLogo registry and are never mapped by name.
 */
const registry: Record<string, ReactNode> = {
  // —— 全站统一操作映射（设计规格 4.2）——
  search: (
    <path d="m21 21-4.35-4.35M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" />
  ),
  import: (
    <>
      <path d="M12 3v10.5M8.5 10 12 13.5 15.5 10" />
      <path d="M4.5 16.5v2A2 2 0 0 0 6.5 20.5h11a2 2 0 0 0 2-2v-2" />
    </>
  ),
  deploy: (
    <>
      <path d="M4.5 7.5 12 3.5l7.5 4v9L12 20.5l-7.5-4z" />
      <path d="M4.5 7.5 12 11.5m0 0 7.5-4M12 11.5v9" />
    </>
  ),
  update: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 3.5V8h-4.5" />
      <path d="M12 8v4.5l3 2" />
    </>
  ),
  restore: (
    <>
      <path d="M4 12a8 8 0 1 0 2.34-5.66" />
      <path d="M4 3.5V8h4.5" />
      <path d="M9.5 10.5 12 13l4-4.5" />
      <path d="M8 17h8" />
    </>
  ),
  delete: (
    <>
      <path d="M4.5 6.5h15M9.5 6.5v-2h5v2M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5" />
      <path d="M10 10.5v7M14 10.5v7" />
    </>
  ),
  "open-external": (
    <>
      <path d="M13.5 5H19v5.5" />
      <path d="M19 5 11 13" />
      <path d="M19 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5h4" />
    </>
  ),
  success: (
    <>
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5 22 20H2Z" />
      <path d="M12 9.5v5M12 17.4v.2" />
    </>
  ),
  failure: (
    <>
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  info: (
    <>
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
      <path d="M12 11v5M12 7.8v.2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  // —— 壳层工具条（返回/前进/通知中心）——
  arrowLeft: (
    <>
      <path d="M20 12H4" />
      <path d="m10 6-6 6 6 6" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4 12h16" />
      <path d="m14 6 6 6-6 6" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4.4 1.5 5.9 2 6.5H4c.5-.6 2-2.1 2-6.5Z" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  // —— 导航映射（与 Sidebar 共用，保持单次朗读）——
  overview: <path d="M4 12 12 4l8 8M6 10v9h12v-9M9 19v-5h6v5" />,
  library: (
    <path d="M5 4.5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5zM19 4.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
  ),
  discovery: (
    <path d="m21 21-4.35-4.35M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" />
  ),
  agents: (
    <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 19a4.5 4.5 0 0 1 9 0M13 18a4 4 0 0 1 7.5 1" />
  ),
  projects: <path d="M4 7.5h6l1.5 2H20v9H4zM4 7.5V5h6l1.5 2.5" />,
  pending: <path d="M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />,
  operations: <path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4" />,
  settings: (
    <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4" />
  ),
};

export type IconName = keyof typeof registry;

/** 注册表快照：预览展板与测试按名称枚举全部图标。 */
export const iconNames = Object.keys(registry) as IconName[];

/** 规格 4.2：按钮 16 / 导航 20 / 提示 24 / 实体与品牌 32–40。 */
export const iconSizes = [16, 20, 24, 32, 40] as const;

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: (typeof iconSizes)[number];
}

/**
 * Decorative icon: always `aria-hidden`. A visible text label or an
 * IconButton `label` carries the meaning instead.
 */
export function Icon({ name, size = 16, ...props }: IconProps) {
  return (
    <svg
      {...props}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {registry[name]}
    </svg>
  );
}

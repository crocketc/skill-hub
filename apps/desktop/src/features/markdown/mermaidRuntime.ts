import DOMPurify from "dompurify";

export type MermaidRenderTheme = "default" | "dark";

export async function renderMermaidSvg(
  code: string,
  id: string,
  theme: MermaidRenderTheme = "default",
): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    flowchart: { htmlLabels: false },
    securityLevel: "strict",
    startOnLoad: false,
    theme,
  });
  const { svg } = await mermaid.render(id, code);
  return String(
    DOMPurify.sanitize(svg, {
      FORBID_TAGS: ["foreignObject", "script"],
      USE_PROFILES: { svg: true, svgFilters: true },
    }),
  );
}

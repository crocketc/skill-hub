import DOMPurify from "dompurify";

export async function renderMermaidSvg(code: string, id: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    flowchart: { htmlLabels: false },
    securityLevel: "strict",
    startOnLoad: false,
  });
  const { svg } = await mermaid.render(id, code);
  return String(
    DOMPurify.sanitize(svg, {
      FORBID_TAGS: ["foreignObject", "script"],
      USE_PROFILES: { svg: true, svgFilters: true },
    }),
  );
}

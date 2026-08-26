import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { type Components } from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import type { MarkdownFacade } from "./api";
import { CodeBlock } from "./CodeBlock";
import { ExternalLink } from "./ExternalLink";
import { MermaidBlock } from "./MermaidBlock";
import { RemoteImage } from "./RemoteImage";
import { classifyMarkdownUrl } from "./sanitize";

interface MarkdownRendererProps {
  facade: MarkdownFacade;
  filePath: string;
  markdown: string;
  skillId: string;
}

interface LocalImageProps {
  alt: string;
  assetPath: string;
  facade: MarkdownFacade;
  filePath: string;
  skillId: string;
}

function LocalImage({ alt, assetPath, facade, filePath, skillId }: LocalImageProps) {
  const assetQuery = useQuery({
    queryFn: () => facade.resolveLocalAsset(skillId, filePath, assetPath),
    queryKey: ["skill-markdown", skillId, "asset", filePath, assetPath],
    retry: false,
  });

  if (!assetQuery.data) {
    return <span role="status">{alt}</span>;
  }
  return <img alt={alt} loading="lazy" src={assetQuery.data} />;
}

function splitFrontmatter(markdown: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match
    ? { body: markdown.slice(match[0].length), frontmatter: match[1] }
    : { body: markdown, frontmatter: null };
}

export function MarkdownRenderer({ facade, filePath, markdown, skillId }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const { body, frontmatter } = splitFrontmatter(markdown);

  const components: Components = {
    a({ children, href }) {
      const target = classifyMarkdownUrl(href ?? "");
      if (target.kind === "external") {
        return (
          <ExternalLink
            onOpen={() => void facade.openExternalUrl(target.target)}
            target={target.target}
          >
            {children}
          </ExternalLink>
        );
      }
      if (target.kind === "fragment") {
        return <a href={`#${target.fragment}`}>{children}</a>;
      }
      if (target.kind === "local") {
        return <a href={target.path}>{children}</a>;
      }
      return <span>{children}</span>;
    },
    code({ children, className }) {
      const language = /language-([^\s]+)/.exec(className ?? "")?.[1];
      if (!language) {
        return <code>{children}</code>;
      }
      const code = String(children).replace(/\n$/, "");
      if (language === "mermaid") {
        return (
          <MermaidBlock
            code={code}
            onExternalTarget={(target) => void facade.openExternalUrl(target)}
          />
        );
      }
      return (
        <CodeBlock
          code={code}
          language={language}
        />
      );
    },
    img({ alt = "", src }) {
      const target = classifyMarkdownUrl(typeof src === "string" ? src : "");
      if (target.kind === "external") {
        return (
          <RemoteImage
            alt={alt}
            host={new URL(target.target).hostname}
            source={target.target}
          />
        );
      }
      if (target.kind === "local") {
        return (
          <LocalImage
            alt={alt}
            assetPath={target.path}
            facade={facade}
            filePath={filePath}
            skillId={skillId}
          />
        );
      }
      return (
        <span className="sh-markdown-blocked-resource">
          {t("markdown.resource.blocked", { target: typeof src === "string" ? src : "" })}
        </span>
      );
    },
    li({ children, className, ...props }) {
      if (className?.includes("task-list-item")) {
        return (
          <li className={className} {...props}>
            <label>{children}</label>
          </li>
        );
      }
      return <li className={className} {...props}>{children}</li>;
    },
    pre({ children }) {
      return <>{children}</>;
    },
  };

  return (
    <article className="sh-markdown-renderer">
      {frontmatter ? (
        <section className="sh-markdown-frontmatter">
          <h3>{t("markdown.frontmatter")}</h3>
          <pre>{frontmatter}</pre>
        </section>
      ) : null}
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm, remarkFrontmatter]}
        skipHtml
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import type { MarkdownFacade } from "./api";
import { CodeBlock } from "./CodeBlock";
import { ExternalLink } from "./ExternalLink";
import { MarkdownImage } from "./MarkdownImage";
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
    return (
      <span aria-busy="true" className="sh-markdown-image">
        <span className="sh-markdown-image__pending" role="status">{alt}</span>
      </span>
    );
  }
  return <MarkdownImage alt={alt} src={assetQuery.data} />;
}

function splitFrontmatter(markdown: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match
    ? { body: markdown.slice(match[0].length), frontmatter: match[1] }
    : { body: markdown, frontmatter: null };
}

/**
 * Markdown 标题在页面中始终渲染在宿主 outline 之下（详情页 h1 -> 章节
 * h2 -> 工作区 h3），所以 `#` 从 h4 开始整体下移；更深的标题收敛到 h6。
 * 视觉层级由 markdown.css 按原映射保留。
 */
const markdownHeadingOffset = 3;
const markdownHeadingMax = 6;

function shiftedHeading(level: number) {
  const shifted = `h${Math.min(level + markdownHeadingOffset, markdownHeadingMax)}`;
  return shifted as "h4" | "h5" | "h6";
}

function Heading({ children, level }: { children?: ReactNode; level: number }) {
  const Tag = shiftedHeading(level);
  return <Tag>{children}</Tag>;
}

export function MarkdownRenderer({ facade, filePath, markdown, skillId }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const { body, frontmatter } = splitFrontmatter(markdown);

  const components: Components = {
    h1({ children }) {
      return <Heading level={1}>{children}</Heading>;
    },
    h2({ children }) {
      return <Heading level={2}>{children}</Heading>;
    },
    h3({ children }) {
      return <Heading level={3}>{children}</Heading>;
    },
    h4({ children }) {
      return <Heading level={4}>{children}</Heading>;
    },
    h5({ children }) {
      return <Heading level={5}>{children}</Heading>;
    },
    h6({ children }) {
      return <Heading level={6}>{children}</Heading>;
    },
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
    table({ children }) {
      // 宽表格由外层滚动容器接管横向溢出，避免列被逐字压缩换行；
      // children 是 thead/tbody，这里重建 table 元素以保留表格语义。
      return (
        <div className="sh-markdown-table-scroll">
          <table>{children}</table>
        </div>
      );
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

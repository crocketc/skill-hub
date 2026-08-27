import { useState } from "react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

interface CodeBlockProps {
  code: string;
  language: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
  };

  return (
    <figure className="sh-markdown-code">
      <figcaption>
        <span>{language || t("markdown.code.plainText")}</span>
        <Button onClick={() => void copy()} size="sm" variant="ghost">
          {copied ? t("markdown.code.copied") : t("markdown.code.copy")}
        </Button>
      </figcaption>
      <Highlight
        code={code}
        language={(language || "markup") as Language}
        theme={themes.github}
      >
        {({ className, getLineProps, getTokenProps, style, tokens }) => (
          <pre className={className} style={style}>
            {tokens.map((line, lineIndex) => (
              <div key={lineIndex} {...getLineProps({ line })}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </figure>
  );
}

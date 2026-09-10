import { useState } from "react";

interface MarkdownImageProps {
  alt: string;
  src: string;
}

/**
 * Markdown 图片的稳定呈现：加载完成前外层保持 `aria-busy` 的占位区域
 * （markdown.css 保留固定最小高度），避免图片到达时正文整体跳动；
 * 加载完成后占位撤销，交还给图片的自然尺寸（`max-width: 100%` 约束）。
 */
export function MarkdownImage({ alt, src }: MarkdownImageProps) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span aria-busy={loaded ? undefined : true} className="sh-markdown-image">
      <img
        alt={alt}
        decoding="async"
        loading="lazy"
        onLoad={() => setLoaded(true)}
        src={src}
      />
    </span>
  );
}

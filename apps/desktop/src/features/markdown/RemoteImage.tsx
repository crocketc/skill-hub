import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

interface RemoteImageProps {
  alt: string;
  host: string;
  source: string;
}

export function RemoteImage({ alt, host, source }: RemoteImageProps) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState(false);

  if (allowed) {
    return <img alt={alt} loading="lazy" src={source} />;
  }

  return (
    <span className="sh-markdown-remote-image">
      <span>{t("markdown.remoteImage.blocked", { host })}</span>
      <Button onClick={() => setAllowed(true)} size="sm" variant="secondary">
        {t("markdown.remoteImage.load")}
      </Button>
    </span>
  );
}

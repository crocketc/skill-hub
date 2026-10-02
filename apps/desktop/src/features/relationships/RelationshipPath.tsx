import { presentRelationshipPath } from "./pathPresentation";

export function RelationshipPath({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const presentation = presentRelationshipPath(path);
  return (
    <code
      aria-label={presentation.fullPath}
      className={className ? `sh-relationship-path ${className}` : "sh-relationship-path"}
      tabIndex={0}
      title={presentation.fullPath}
    >
      {presentation.label}
    </code>
  );
}

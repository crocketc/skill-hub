import { useState } from "react";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";

export function SkillDetailPreview() {
  const [facade] = useState(() => createMockSkillDetailFacade());
  const [markdownFacade] = useState(() => createMockMarkdownFacade());
  return <SkillDetailPage facade={facade} markdownFacade={markdownFacade} />;
}

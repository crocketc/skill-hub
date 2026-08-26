import { useState } from "react";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";

export function SkillDetailPreview() {
  const [facade] = useState(() => createMockSkillDetailFacade());
  return <SkillDetailPage facade={facade} />;
}

import { RelationshipsLayout } from "../RelationshipsLayout";
import { graphPreviewFacade } from "./graphPreviewFacade";
import { SkillGraphPage } from "./SkillGraphPage";

/** Development-only route fixture for exercising graph navigation end to end. */
export function GraphPreview() {
  return (
    <RelationshipsLayout scope="graph">
      <SkillGraphPage facade={graphPreviewFacade} />
    </RelationshipsLayout>
  );
}

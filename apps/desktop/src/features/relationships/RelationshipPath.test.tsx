import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { RelationshipPath } from "./RelationshipPath";

it("keeps long normalized paths available to keyboard and hover while compacting the visible label", () => {
  render(
    <RelationshipPath
      path={"\\\\?\\C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader"}
    />,
  );

  const path = screen.getByLabelText(
    "C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader",
  );
  expect(path).toHaveTextContent("…\\codex\\skills\\pdf-reader");
  expect(path).toHaveAttribute(
    "title",
    "C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader",
  );
  path.focus();
  expect(path).toHaveFocus();
});

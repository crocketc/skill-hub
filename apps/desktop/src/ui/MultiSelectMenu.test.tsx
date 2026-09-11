import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MultiSelectMenu } from "./MultiSelectMenu";

const options = [
  { label: "docs", value: "docs" },
  { label: "pdf", value: "pdf" },
];

function Harness({ onChange }: { onChange?: (values: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <div>
      <MultiSelectMenu
        label="Tags"
        onChange={(values) => {
          setSelected(values);
          onChange?.(values);
        }}
        options={options}
        selected={selected}
        summary={selected.length > 0 ? `${selected.length} selected` : "Any"}
      />
      <p>outside</p>
    </div>
  );
}

describe("MultiSelectMenu", () => {
  it("opens the option menu from the trigger and reflects the summary", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByText("Tags", { selector: ".sh-filter-dropdown__label" })).toBeVisible();
    expect(screen.queryByRole("menu", { name: "Tags" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tags" }));

    expect(screen.getByRole("menu", { name: "Tags" })).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: "docs" })).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: "pdf" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Tags" })).toHaveTextContent("Any");
  });

  it("toggles each option independently and keeps the selection ordered", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Tags" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "pdf" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "docs" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "docs" }));

    expect(onChange).toHaveBeenNthCalledWith(1, ["pdf"]);
    expect(onChange).toHaveBeenNthCalledWith(2, ["pdf", "docs"]);
    expect(onChange).toHaveBeenNthCalledWith(3, ["pdf"]);
  });

  it("closes when the pointer goes down outside the menu", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Tags" }));
    expect(screen.getByRole("menu", { name: "Tags" })).toBeVisible();

    fireEvent.pointerDown(screen.getByText("outside"));

    expect(screen.queryByRole("menu", { name: "Tags" })).not.toBeInTheDocument();
  });

  it("reports each option state through aria-checked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Tags" }));
    const docs = screen.getByRole("menuitemcheckbox", { name: "docs" });
    expect(docs).toHaveAttribute("aria-checked", "false");

    await user.click(docs);
    expect(screen.getByRole("menuitemcheckbox", { name: "docs" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

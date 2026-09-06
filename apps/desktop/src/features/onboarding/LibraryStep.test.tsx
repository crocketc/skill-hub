import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { LibraryStep } from "./LibraryStep";

const defaultLibraryPath = "C:\\Users\\Test\\SkillHub\\skills";
const customLibraryPath = "D:\\Custom\\Hub";

function noop() {
  return undefined;
}

function renderLibraryStep(customLibraryPath?: string | null, i18n = createSkillHubI18n(["zh-CN"])) {
  return i18n.then((instance) => {
    render(
      <I18nextProvider i18n={instance}>
        <LibraryStep
          customLibraryPath={customLibraryPath}
          libraryPath={defaultLibraryPath}
          onThemeChange={noop}
          theme="moss-neutral"
        />
      </I18nextProvider>,
    );
    return instance;
  });
}

it("labels a picked custom directory as the selected library location", async () => {
  await renderLibraryStep(customLibraryPath);

  expect(screen.getByText("已选择的集中库位置")).toBeVisible();
  expect(screen.queryByText("默认集中库位置")).not.toBeInTheDocument();
  expect(screen.getByText(customLibraryPath)).toBeVisible();
});

it("keeps the default location label until a custom directory is chosen", async () => {
  await renderLibraryStep(null);

  expect(screen.getByText("默认集中库位置")).toBeVisible();
  expect(screen.queryByText("已选择的集中库位置")).not.toBeInTheDocument();
  expect(screen.getByText(defaultLibraryPath)).toBeVisible();
});

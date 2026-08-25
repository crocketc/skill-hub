import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider, useTheme } from "../../styles/ThemeProvider";
import {
  DeploymentBarChart,
  type DeploymentBarChartRuntimeProps,
} from "./DeploymentBarChart";

const items = [
  {
    buttonLabel: "View Codex's 12 deployments",
    count: 12,
    key: "openai.codex-cli",
    label: "Codex",
    target: "/agents/openai.codex-cli?view=deployments",
  },
  {
    buttonLabel: "View Claude Code's 3 deployments",
    count: 3,
    key: "anthropic.claude-code",
    label: "Claude Code",
    target: "/agents/anthropic.claude-code?view=deployments",
  },
] as const;

function mockThemeBrowserEnvironment() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? false : query === "(prefers-reduced-motion: reduce)" ? true : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "getComputedStyle",
    vi.fn((element: Element) => {
      const theme = (element as HTMLElement).dataset.theme ?? "moss-neutral";
      const values =
        theme === "grok-night"
          ? {
              "--color-accent": "#f2f3ef",
              "--color-accent-strong": "#d9dcd6",
              "--color-border": "rgb(241 242 238 / 11%)",
              "--color-surface": "#151717",
              "--color-surface-raised": "#1b1d1d",
              "--color-text": "#f0f1ed",
              "--color-text-muted": "#a2a7a1",
            }
          : {
              "--color-accent": "#3f7259",
              "--color-accent-strong": "#315b46",
              "--color-border": "rgb(24 43 29 / 10%)",
              "--color-surface": "#fbfcf9",
              "--color-surface-raised": "#f7f9f5",
              "--color-text": "#1c251f",
              "--color-text-muted": "#5f6d63",
            };

      return {
        getPropertyValue: (name: string) => values[name as keyof typeof values] ?? "",
      } as CSSStyleDeclaration;
    }),
  );
}

function ThemeSwitchHarness({
  runtimeLoader,
}: {
  runtimeLoader: () => Promise<{ default: (props: DeploymentBarChartRuntimeProps) => JSX.Element }>;
}) {
  const { setAppearance } = useTheme();

  return (
    <>
      <button onClick={() => setAppearance("grok-night")} type="button">
        Switch theme
      </button>
      <DeploymentBarChart
        ariaLabel="Deployment count by agent"
        detailsLabel="Deployment count details"
        dimension="agent"
        items={[...items]}
        runtimeLoader={runtimeLoader}
      />
    </>
  );
}

async function renderWithEnglishLocale(node: JSX.Element) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

it("keeps the numeric deployment list visible while the lazy chart runtime is still unresolved", async () => {
  await renderWithEnglishLocale(
    <ThemeProvider>
      <MemoryRouter>
        <DeploymentBarChart
          ariaLabel="Deployment count by agent"
          detailsLabel="Deployment count details"
          dimension="agent"
          items={[...items]}
          runtimeLoader={() => new Promise(() => undefined)}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );

  expect(screen.getByRole("img", { name: "Deployment count by agent" })).toBeVisible();
  expect(screen.getByText("Loading deployment chart")).toBeVisible();
  expect(screen.getByRole("list", { name: "Deployment count details" })).toHaveTextContent(
    "Codex 12Claude Code 3",
  );
});

it("resolves palette values from theme tokens and keeps chart animation disabled", async () => {
  mockThemeBrowserEnvironment();

  const runtime = ({
    animation,
    palette,
  }: DeploymentBarChartRuntimeProps) => (
    <output data-testid="runtime-props">
      {`${String(animation)}|${palette.barColor}|${palette.axisLabelColor}|${palette.surfaceColor}`}
    </output>
  );

  await act(async () => {
    await renderWithEnglishLocale(
      <ThemeProvider>
        <MemoryRouter>
          <ThemeSwitchHarness runtimeLoader={async () => ({ default: runtime })} />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });

  expect(await screen.findByTestId("runtime-props")).toHaveTextContent(
    "false|#3f7259|#5f6d63|#f7f9f5",
  );

  fireEvent.click(screen.getByRole("button", { name: "Switch theme" }));

  expect(await screen.findByTestId("runtime-props")).toHaveTextContent(
    "false|#f2f3ef|#a2a7a1|#1b1d1d",
  );
});

import { expect, test } from "./fixtures";

/**
 * T3-D Agent 与项目页 DEV 预览：实体卡片、注册抽屉、焦点恢复与响应式。
 * 只断言公开 DOM、可访问名称、焦点与几何；截图产物走 --output 指定的任务 /tmp 目录。
 */

test.use({ locale: "en-US" });

const previewWidths = [800, 1024, 1280, 1440] as const;

const themeNames = [
  "moss-neutral",
  "spring-signal",
  "terracotta",
  "codex-light",
  "ocean-cobalt",
  "sakura",
  "aurora",
  "roast",
  "grok-night",
] as const;

const previewRoutes = ["/__preview/agents", "/__preview/agents/detail", "/__preview/projects"] as const;

test("agent cards expose a clean title link, directory path, and status text", async ({ page }) => {
  await page.goto("/__preview/agents");

  await expect(page.getByRole("main").getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  // Title link keeps the instance name as its whole accessible name.
  const codexLink = page.getByRole("link", { name: "Codex CLI", exact: true });
  await expect(codexLink).toBeVisible();

  // Directory fact stays readable as its own element, not buried in the link.
  await expect(page.getByText("Skill directory").first()).toBeVisible();
  await expect(page.getByText("C:/Users/Developer/AppData/Local/SkillHub/agents/codex/skills")).toBeVisible();

  // Status is always icon/marker plus text, never color alone.
  await expect(page.getByText("Accessible").first()).toBeVisible();
  await expect(page.getByText("Currently inaccessible")).toBeVisible();
  await expect(page.getByText("Related directory only")).toBeVisible();

  // Custom agents keep edit and confirmed removal on the card.
  const reviewerCard = page.getByRole("listitem").filter({
    has: page.getByRole("link", { name: "Release Reviewer", exact: true }),
  });
  await expect(reviewerCard.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(reviewerCard.getByRole("button", { name: "Remove" })).toBeVisible();

  // Discovered agents never offer custom agent actions (only Reviewer + Auditor do).
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(2);
});

test("project cards expose title, path, tags, access, and a next step", async ({ page }) => {
  await page.goto("/__preview/projects");

  await expect(page.getByRole("main").getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  const auroraCard = page.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Aurora Web" }),
  });
  await expect(auroraCard).toBeVisible();
  await expect(auroraCard.getByText("D:/Work/very-long-project-paths/aurora-web/workspace/root")).toBeVisible();
  await expect(auroraCard.getByText("rust", { exact: true })).toBeVisible();

  // Access state comes from the discovery snapshot; the associated Agent
  // count comes from the listed project facts.
  await expect(auroraCard.getByText("Accessible")).toBeVisible();
  await expect(auroraCard.getByText("Associated Agents: 1")).toBeVisible();

  // The stored plan has one unresolved conflict, so the card points there.
  await expect(auroraCard.getByRole("button", { name: "Resolve assembly conflicts (1)" })).toBeVisible();

  // Projects absent from the snapshot honestly report "not on this device".
  const docsCard = page.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Docs Pipeline" }),
  });
  await expect(docsCard.getByText("Not on this device")).toBeVisible();
  await expect(docsCard.getByRole("button", { name: "Declare shared config requirements in project details" })).toBeVisible();

  // The quick drawer keeps working from the card title.
  await page.getByRole("button", { name: "Aurora Web" }).click();
  const drawer = page.getByRole("dialog", { name: "Aurora Web" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Accessible")).toBeVisible();
  await expect(drawer.getByText("Resolve assembly conflicts (1)")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Aurora Web" })).toBeFocused();
});

test("project registration runs in a drawer and returns focus to its trigger", async ({ page }) => {
  await page.goto("/__preview/projects");

  await page.getByRole("button", { name: "Register project" }).click();
  const registration = page.getByRole("dialog", { name: "Register local project" });
  await expect(registration).toBeVisible();

  // Escape closes like a cancel and restores focus to the trigger.
  await page.keyboard.press("Escape");
  await expect(registration).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Register project" })).toBeFocused();

  await page.getByRole("button", { name: "Register project" }).click();
  await expect(registration).toBeVisible();

  await registration.getByRole("button", { name: "Choose project directory" }).click();
  await expect(registration.getByText("C:/Preview/Aurora", { exact: true })).toBeVisible();
  await expect(registration.getByRole("textbox", { name: "Project name" })).toHaveValue("Aurora");

  await registration.getByRole("checkbox", { name: "OpenAI · Codex CLI" }).check();
  await registration.getByRole("button", { name: "Register project" }).click();

  // Success keeps the drawer open with explicit next actions instead of
  // closing silently: open the (host-wired) project details, or just finish.
  await expect(registration.getByText("Project registered")).toBeVisible();
  await expect(registration.getByRole("button", { name: "Open project details" })).toBeVisible();
  await registration.getByRole("button", { name: "Done" }).click();
  await expect(registration).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Register project" })).toBeFocused();

  const registeredCard = page.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Aurora", exact: true }),
  });
  await expect(registeredCard).toBeVisible();
  await expect(registeredCard.getByText("Not on this device")).toBeVisible();
});

test("project registration keeps the read-only preview boundary inside the drawer", async ({ page }) => {
  await page.goto("/__preview/projects");

  await page.getByRole("button", { name: "Register project" }).click();
  const registration = page.getByRole("dialog", { name: "Register local project" });

  await registration.getByRole("button", { name: "Choose project directory" }).click();
  await expect(registration.getByText("The preview only reads the directory. It creates no project, imports no Skill, and writes no files.")).toBeVisible();
  await expect(registration.getByText("C:/Preview/Aurora/.claude/skills", { exact: true })).toBeVisible();
  await expect(registration.getByRole("checkbox", { name: "anthropic · anthropic.claude-code" })).toBeChecked();
});

test.describe("previews stay free of horizontal overflow at every benchmark width", () => {
  for (const width of previewWidths) {
    test(`no root horizontal overflow at ${width}px and 900px height`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const route of previewRoutes) {
        await page.goto(route);
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          overflow.scrollWidth,
          `${route} scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth}) at ${width}px`,
        ).toBeLessThanOrEqual(overflow.clientWidth);
      }
    });
  }
});

test("long directory paths wrap instead of being clipped at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/__preview/agents");

  const longPath = page.getByText(
    "D:/Very/Long/Windows/Library/Directory/On/A/Second/Volume/with/project/workspace/skills",
  );
  await expect(longPath).toBeVisible();
  const box = (await longPath.boundingBox())!;
  expect(box.height, "a long path must wrap onto multiple lines").toBeGreaterThan(24);
});

test("the last card action stays reachable at the 800x600 minimum", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/__preview/agents");

  const remove = page.getByRole("button", { name: "Remove" }).last();
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeVisible();

  // The registration drawer scrolls internally and keeps its actions usable.
  await page.goto("/__preview/projects");
  await page.getByRole("button", { name: "Register project" }).click();
  const registration = page.getByRole("dialog", { name: "Register local project" });
  await expect(registration).toBeVisible();
  const confirm = registration.getByRole("button", { name: "Register project" });
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeVisible();
});

test("the agent detail keeps every discovered path readable at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/__preview/agents/detail");

  await expect(page.getByRole("list", { name: "Discovered paths" })).toBeVisible();
  await expect(page.getByText("C:/Users/preview/AppData/Local/SkillHub/agents/auditor/very/long/global skill directory")).toBeVisible();
  await expect(page.getByText("Auditor Desktop")).toBeVisible();
});

test.describe("all nine themes render the reworked pages at 1280x900", () => {
  for (const theme of themeNames) {
    test(`${theme} keeps statuses, cards, and focus usable`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
      });
      const page = await context.newPage();
      await page.addInitScript((value) => {
        window.localStorage.setItem("skillhub.appearance", value);
      }, theme);

      await page.goto("/__preview/agents");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
      await expect(page.getByText("Currently inaccessible")).toBeVisible();

      await page.goto("/__preview/projects");
      await page.getByRole("button", { name: "Aurora Web" }).focus();
      await expect(page.locator(":focus")).toBeVisible();

      await context.close();
    });
  }
});

test("grok-night keeps both pages overflow-free at every benchmark width", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("skillhub.appearance", "grok-night");
  });
  for (const width of previewWidths) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of previewRoutes) {
      await page.goto(route);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "grok-night");
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    }
  }
});

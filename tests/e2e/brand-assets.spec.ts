import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

/**
 * TC-GR-09-M04 的浏览器自动化层：已支持品牌的内置 Logo 素材能被真实浏览器
 * 通过 HTTP 加载并解码；未知素材不被伪装成图片。品牌 id 与素材的映射完整性、
 * 未知品牌的颜色标签回退已由 BrandTag.test.tsx 在组件层锁定；视觉观感仍留
 * 真机人工判断。
 */

const ASSET_DIR = join(__dirname, "..", "..", "apps", "desktop", "public", "brand", "agents", "lobehub");

const shippedAssets = readdirSync(ASSET_DIR).filter((file) => file.endsWith(".svg"));

test("every shipped brand logo is served as an SVG image", async ({ request }) => {
  expect(shippedAssets.length).toBeGreaterThan(0);
  for (const file of shippedAssets) {
    const response = await request.get(`/brand/agents/lobehub/${file}`);
    expect(response.status(), file).toBe(200);
    expect(response.headers()["content-type"], file).toContain("image/svg");
    expect((await response.body()).length, file).toBeGreaterThan(0);
  }
});

test("the browser decodes every shipped brand logo", async ({ page }) => {
  await page.goto("/__preview/skill-library");
  const decoded = await page.evaluate(
    async (files) =>
      Object.fromEntries(
        await Promise.all(
          files.map(
            (file) =>
              new Promise<[string, number]>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve([file, image.naturalWidth]);
                image.onerror = () => reject(new Error(`failed to load ${file}`));
                image.src = `/brand/agents/lobehub/${file}`;
              }),
          ),
        ),
      ),
    shippedAssets,
  );
  for (const [file, width] of Object.entries(decoded)) {
    expect(width, file).toBeGreaterThan(0);
  }
});

test("an unknown brand asset is not served as an image", async ({ request }) => {
  const response = await request.get("/brand/agents/lobehub/does-not-exist.svg");
  const contentType = response.headers()["content-type"] ?? "";
  expect(contentType).not.toContain("image/");
});

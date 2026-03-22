import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// All tests in this file require an authenticated session.
// We log in once in beforeEach so each test starts from a known state.

test.describe("Dashboard (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;

    if (!email || !password) {
      test.skip(true, "TEST_USER_EMAIL / TEST_USER_PASSWORD env vars not set");
      return;
    }

    await loginAs(page, email, password);
  });

  test("Dashboard loads and shows overview content", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Should not redirect away
    expect(page.url()).toContain("/dashboard");

    // Expect at least one heading-like element (Overview, Dashboard, Alerts, etc.)
    const heading = page.locator("h1, h2, h3").first();
    await expect(heading).toBeVisible({ timeout: 8000 });
  });

  test("Navigate to /alerts — shows alerts list or empty state", async ({ page }) => {
    await page.goto("/alerts");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/alerts");

    // Either a table/list of alerts or an empty-state element must be present
    const content = page.locator("h1, h2, [data-testid='alerts-empty'], table, ul");
    await expect(content.first()).toBeVisible({ timeout: 8000 });
  });

  test("Navigate to /settings — shows Settings heading", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/settings");

    // Look for a heading that includes "Settings" (case-insensitive)
    const heading = page.locator("h1, h2").filter({ hasText: /settings/i }).first();
    await expect(heading).toBeVisible({ timeout: 8000 });
  });

  test("Navigate to /integrations — shows integrations page", async ({ page }) => {
    await page.goto("/integrations");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/integrations");

    // Integrations page should render some content
    const content = page.locator("h1, h2, [data-testid='integrations']").first();
    await expect(content).toBeVisible({ timeout: 8000 });
  });
});

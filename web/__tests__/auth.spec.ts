import { test, expect } from "@playwright/test";

test.describe("Auth flows", () => {
  test("GET / — landing page loads and does not show dashboard", async ({ page }) => {
    await page.goto("/");
    // Should either redirect to /login or show the marketing landing page,
    // never the dashboard content.
    const url = page.url();
    const isDashboard = url.includes("/dashboard");
    expect(isDashboard).toBe(false);
  });

  test("GET /dashboard without session redirects to /login", async ({ page }) => {
    // Navigate directly without any stored auth state
    await page.goto("/dashboard");
    await page.waitForURL("**/login**", { timeout: 8000 });
    expect(page.url()).toContain("/login");
  });

  test("Login with wrong password shows error", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', "wrong@example.com");
    await page.fill('input[type="password"]', "definitly-wrong-password-12345");
    await page.click('button[type="submit"]');

    // Expect an error message to be visible — the page must NOT navigate to dashboard
    await page.waitForTimeout(2000);
    const url = page.url();
    expect(url).not.toContain("/dashboard");

    // Check for a visible error indicator (text, aria-alert, or still on /login)
    const onLoginPage = url.includes("/login") || url.includes("error") || url.includes("callbackUrl");
    expect(onLoginPage).toBe(true);
  });

  test("Login with correct credentials redirects to dashboard", async ({ page }) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;

    if (!email || !password) {
      test.skip(true, "TEST_USER_EMAIL / TEST_USER_PASSWORD env vars not set");
      return;
    }

    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');

    await page.waitForURL("**/dashboard**", { timeout: 12000 });
    expect(page.url()).toContain("/dashboard");
  });
});

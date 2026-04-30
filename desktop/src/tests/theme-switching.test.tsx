import { describe, expect, it, beforeEach } from "vitest";

import { useAppState } from "@/lib/store/useAppState";

beforeEach(() => {
  useAppState.setState({ themeMode: "auto", systemTheme: "light", activeRepoId: null });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-system-theme");
});

describe("theme store", () => {
  it("setting themeMode to dark writes data-theme=dark on <html>", () => {
    useAppState.getState().setThemeMode("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("setting themeMode to light writes data-theme=light", () => {
    useAppState.getState().setThemeMode("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("setting themeMode to auto records data-theme=auto + data-system-theme", () => {
    useAppState.getState().setThemeMode("auto");
    expect(document.documentElement.getAttribute("data-theme")).toBe("auto");
    expect(document.documentElement.getAttribute("data-system-theme")).toBeTruthy();
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// react-resizable-panels uses ResizeObserver — already shimmed by
// tests/setup.ts. Shiki is dynamic-imported inside the component; we
// stub it so jsdom doesn't try to load WASM.
vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (code: string) => {
    // Shape Shiki normally produces — one `<span class="line">` per line.
    return code
      .split("\n")
      .map((line) => `<span class="line">${line}</span>`)
      .join("");
  }),
}));

import { DiffViewer } from "@/components/DiffViewer";

const FIXTURE = [
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1,5 +1,5 @@",
  " function add(a: number, b: number) {",
  "-  return a - b;",
  "+  return a + b;",
  " }",
  " ",
  " export { add };",
  "@@ -20,3 +20,4 @@",
  " function multiply(a: number, b: number) {",
  "+  if (b === 0) return 0;",
  "   return a * b;",
  " }",
].join("\n");

function bigFixture(): string {
  // ~50 lines, 2 hunks — matches the DoD shape.
  const lines = ["--- a/big.ts", "+++ b/big.ts", "@@ -1,20 +1,21 @@"];
  for (let i = 0; i < 19; i += 1) {
    lines.push(` const v${i} = ${i};`);
  }
  lines.push("+const inserted = true;");
  lines.push(" const last = 99;");
  lines.push("@@ -100,15 +101,15 @@");
  for (let i = 0; i < 7; i += 1) {
    lines.push(` const w${i} = ${i};`);
  }
  lines.push("-  return wrong;");
  lines.push("+  return correct;");
  for (let i = 0; i < 6; i += 1) {
    lines.push(` const x${i} = ${i};`);
  }
  return lines.join("\n");
}

describe("DiffViewer", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders a fixture diff (50 lines, 2 hunks) inline without crashing", async () => {
    render(<DiffViewer diff={bigFixture()} language="typescript" mode="inline" />);

    const viewer = screen.getByTestId("diff-viewer");
    expect(viewer).toHaveAttribute("data-mode", "inline");
    expect(viewer).toHaveAttribute("data-hunk-count", "2");

    // Two hunk headers + two collapsible hunks.
    expect(screen.getAllByTestId("diff-hunk")).toHaveLength(2);
    expect(screen.getAllByTestId("diff-hunk-header")).toHaveLength(2);

    // Inline body present.
    await waitFor(() => {
      expect(screen.getAllByTestId("diff-hunk-inline").length).toBeGreaterThan(0);
    });

    // At least one add and one del line classified correctly.
    const lines = screen.getAllByTestId("diff-line");
    const adds = lines.filter((l) => l.getAttribute("data-line-type") === "add");
    const dels = lines.filter((l) => l.getAttribute("data-line-type") === "del");
    expect(adds.length).toBeGreaterThan(0);
    expect(dels.length).toBeGreaterThan(0);
  });

  it("toggles inline ↔ side-by-side and persists the split ratio", async () => {
    const { rerender } = render(
      <DiffViewer diff={FIXTURE} language="typescript" mode="inline" />,
    );

    expect(screen.getByTestId("diff-viewer")).toHaveAttribute(
      "data-mode",
      "inline",
    );
    expect(screen.getAllByTestId("diff-hunk-inline").length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("diff-hunk-split")).toHaveLength(0);

    // Swap to side-by-side. The split panes mount and the inline body
    // is gone.
    rerender(
      <DiffViewer diff={FIXTURE} language="typescript" mode="side-by-side" />,
    );
    expect(screen.getByTestId("diff-viewer")).toHaveAttribute(
      "data-mode",
      "side-by-side",
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("diff-hunk-split").length).toBeGreaterThan(0);
    });
    expect(screen.queryAllByTestId("diff-hunk-inline")).toHaveLength(0);
    expect(screen.getAllByTestId("diff-side-old").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("diff-side-new").length).toBeGreaterThan(0);

    // Persistence: write a custom split, re-mount, expect it to load.
    window.localStorage.setItem("inari.diff.split", "70.0");
    rerender(<div />); // unmount
    rerender(
      <DiffViewer diff={FIXTURE} language="typescript" mode="side-by-side" />,
    );
    const splits = await screen.findAllByTestId("diff-hunk-split");
    expect(splits[0]).toHaveAttribute("data-split", "70.0");
  });

  it("collapses a hunk on header click", async () => {
    render(<DiffViewer diff={FIXTURE} language="typescript" mode="inline" />);
    const headers = screen.getAllByTestId("diff-hunk-header");
    expect(headers[0]).toHaveAttribute("data-hunk-open", "true");

    act(() => {
      fireEvent.click(headers[0]!);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("diff-hunk-header")[0]!).toHaveAttribute(
        "data-hunk-open",
        "false",
      );
    });
  });

  it("renders a binary-diff sentinel when the diff is binary", () => {
    render(
      <DiffViewer
        diff="Binary files a/logo.png and b/logo.png differ"
        language="png"
        mode="inline"
      />,
    );
    const viewer = screen.getByTestId("diff-viewer");
    expect(viewer).toHaveAttribute("data-binary", "true");
    expect(viewer).toHaveTextContent(/Binary file/i);
  });
});

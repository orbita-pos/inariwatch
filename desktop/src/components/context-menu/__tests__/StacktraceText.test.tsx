import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StacktraceText } from "@/components/context-menu/StacktraceText";

describe("<StacktraceText>", () => {
  it("renders plain prose unchanged when no location matches", () => {
    render(<StacktraceText text="just prose without paths" testId="t" />);
    expect(screen.queryByTestId("t-loc-0")).toBeNull();
  });

  it("wraps a Node V8 frame with a context-menu trigger", () => {
    const text = "    at handler (/srv/app/server.js:42:13)";
    render(<StacktraceText text={text} testId="t" />);
    const wrapped = screen.getByTestId("t-loc-1");
    expect(wrapped.textContent).toBe("at handler (/srv/app/server.js:42:13)");
    // Right-click should open the preset menu — sanity check the
    // wiring without re-asserting menu items (covered by
    // StacktraceContextMenu.test.tsx).
    fireEvent.contextMenu(wrapped);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("emits one wrapper per parsed location", () => {
    const text = [
      "    at outer (/srv/a.js:10:1)",
      "    at inner (/srv/b.js:20:1)",
    ].join("\n");
    render(<StacktraceText text={text} testId="t" />);
    // segments: [text, loc, text, loc] OR with leading text empty;
    // we just count location wrappers.
    const wrappers = [0, 1, 2, 3, 4]
      .map((i) => screen.queryByTestId(`t-loc-${i}`))
      .filter(Boolean);
    expect(wrappers.length).toBe(2);
  });
});

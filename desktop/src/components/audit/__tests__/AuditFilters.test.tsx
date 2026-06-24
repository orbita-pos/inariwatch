import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuditFilters } from "@/components/audit/AuditFilters";
import type { AuditFilter, PermissionRow } from "@/lib/audit-ui-ipc";

const TOOL_OPTIONS: PermissionRow[] = [
  {
    name: "desktop.read_clipboard",
    description: "Read",
    default_permission: "auto",
    override_level: null,
  },
  {
    name: "desktop.notify",
    description: "Notify",
    default_permission: "auto",
    override_level: null,
  },
  {
    name: "local.run_shell",
    description: "Shell",
    default_permission: "confirm",
    override_level: null,
  },
];

const BLANK: AuditFilter = { limit: 50, order: "newest_first" };

describe("AuditFilters", () => {
  it("emits a patched filter when typing in the text search", () => {
    const onChange = vi.fn();
    render(
      <AuditFilters
        filter={BLANK}
        onChange={onChange}
        toolOptions={TOOL_OPTIONS}
      />,
    );
    fireEvent.change(screen.getByTestId("audit-filter-text"), {
      target: { value: "boom" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [AuditFilter];
    expect(next.text).toBe("boom");
    // Resetting cursor on every patch is part of the contract.
    expect(next.cursor_started_at_ms).toBeUndefined();
    expect(next.limit).toBe(50);
  });

  it("emits the chosen tool name when the dropdown changes", () => {
    const onChange = vi.fn();
    render(
      <AuditFilters
        filter={BLANK}
        onChange={onChange}
        toolOptions={TOOL_OPTIONS}
      />,
    );
    fireEvent.change(screen.getByTestId("audit-filter-tool"), {
      target: { value: "local.run_shell" },
    });
    const [next] = onChange.mock.calls[0] as [AuditFilter];
    expect(next.tool_name).toBe("local.run_shell");
  });

  it("toggles the success tri-state radios with the right semantic value", () => {
    const onChange = vi.fn();
    render(
      <AuditFilters
        filter={BLANK}
        onChange={onChange}
        toolOptions={TOOL_OPTIONS}
      />,
    );
    fireEvent.click(screen.getByTestId("audit-filter-success-fail"));
    expect((onChange.mock.calls[0] as [AuditFilter])[0].success).toBe(false);

    onChange.mockClear();
    fireEvent.click(screen.getByTestId("audit-filter-success-ok"));
    expect((onChange.mock.calls[0] as [AuditFilter])[0].success).toBe(true);

    onChange.mockClear();
    fireEvent.click(screen.getByTestId("audit-filter-success-all"));
    expect((onChange.mock.calls[0] as [AuditFilter])[0].success).toBeUndefined();
  });

  it("converts date-only inputs to UTC midnight ms", () => {
    const onChange = vi.fn();
    render(
      <AuditFilters
        filter={BLANK}
        onChange={onChange}
        toolOptions={TOOL_OPTIONS}
      />,
    );
    fireEvent.change(screen.getByTestId("audit-filter-since"), {
      target: { value: "2025-04-23" },
    });
    const [next] = onChange.mock.calls[0] as [AuditFilter];
    // 2025-04-23T00:00:00Z = 1745366400000
    expect(next.since_ms).toBe(Date.parse("2025-04-23T00:00:00Z"));
  });

  it("clears all filters except limit + order when the Clear button is pressed", () => {
    const onChange = vi.fn();
    render(
      <AuditFilters
        filter={{
          ...BLANK,
          text: "boom",
          tool_name: "desktop.notify",
          success: false,
        }}
        onChange={onChange}
        toolOptions={TOOL_OPTIONS}
      />,
    );
    fireEvent.click(screen.getByTestId("audit-filter-clear"));
    expect(onChange).toHaveBeenCalledWith({
      limit: 50,
      order: "newest_first",
    });
  });
});

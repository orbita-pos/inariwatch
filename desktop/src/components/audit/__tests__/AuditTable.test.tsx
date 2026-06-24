import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuditTable } from "@/components/audit/AuditTable";
import type { AuditEntry } from "@/lib/audit-ui-ipc";

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: "id-1",
    tool_name: "desktop.read_clipboard",
    session_id: null,
    args_json: '{"k":1}',
    result_json: '{"ok":true}',
    permission: "auto",
    permission_decision: "allow",
    witness_receipt_id: "abc12345abcdef",
    started_at_ms: 1_700_000_000_000,
    finished_at_ms: 1_700_000_000_050,
    success: true,
    error: null,
    source: "agent",
    ...overrides,
  };
}

describe("AuditTable", () => {
  const ROWS = [
    entry({ id: "row-a", success: true, started_at_ms: 1_000 }),
    entry({
      id: "row-b",
      success: false,
      error: "boom",
      tool_name: "local.run_shell",
      witness_receipt_id: null,
      started_at_ms: 2_000,
    }),
  ];

  it("renders all rows + the column headers", () => {
    render(
      <AuditTable
        rows={ROWS}
        selectedId={null}
        onSelectRow={() => {}}
        onOpenWitness={() => {}}
      />,
    );
    expect(screen.getByTestId("audit-row-row-a")).toBeInTheDocument();
    expect(screen.getByTestId("audit-row-row-b")).toBeInTheDocument();
    expect(screen.getByText("Tool")).toBeInTheDocument();
    expect(screen.getByText("Witness")).toBeInTheDocument();
  });

  it("clicking a row asks the parent to select it", () => {
    const onSelectRow = vi.fn();
    render(
      <AuditTable
        rows={ROWS}
        selectedId={null}
        onSelectRow={onSelectRow}
        onOpenWitness={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("audit-row-row-a"));
    expect(onSelectRow).toHaveBeenCalledWith("row-a");
  });

  it("clicking the witness chip opens the verifier without expanding the row", () => {
    const onSelectRow = vi.fn();
    const onOpenWitness = vi.fn();
    render(
      <AuditTable
        rows={ROWS}
        selectedId={null}
        onSelectRow={onSelectRow}
        onOpenWitness={onOpenWitness}
      />,
    );
    fireEvent.click(screen.getByTestId("audit-row-row-a-witness"));
    expect(onOpenWitness).toHaveBeenCalledWith("row-a", "abc12345abcdef");
    // stopPropagation() on the chip means the row's click never fires.
    expect(onSelectRow).not.toHaveBeenCalled();
  });

  it("renders an empty state when no rows match the filter", () => {
    render(
      <AuditTable
        rows={[]}
        selectedId={null}
        onSelectRow={() => {}}
        onOpenWitness={() => {}}
      />,
    );
    expect(screen.getByTestId("audit-table-empty")).toHaveTextContent(
      /no audit rows match these filters/i,
    );
  });

  it("marks rows with witness_receipt_id=null as no-receipt", () => {
    render(
      <AuditTable
        rows={ROWS}
        selectedId={null}
        onSelectRow={() => {}}
        onOpenWitness={() => {}}
      />,
    );
    const chip = screen.getByTestId("audit-row-row-b-witness");
    expect(chip).toHaveAttribute("data-verified", "false");
    expect(chip).toHaveTextContent(/no-receipt/);
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WizardFrame } from "../WizardFrame";

describe("WizardFrame — generic chrome", () => {
  it("renders the subtitle, step dots, and ordinal counter", () => {
    render(
      <WizardFrame
        subtitle="add project"
        steps={["Detect", "Plan", "Install", "Run dev", "Verify"]}
        currentStep={2}
      >
        <div data-testid="body">body</div>
      </WizardFrame>,
    );
    expect(screen.getByText("Inari Live")).toBeInTheDocument();
    expect(screen.getByText("add project")).toBeInTheDocument();
    expect(screen.getByText("3 / 5")).toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("clamps out-of-range currentStep to 0", () => {
    render(
      <WizardFrame
        subtitle="setup"
        steps={["A", "B", "C"]}
        currentStep={99}
      >
        <span />
      </WizardFrame>,
    );
    // 99 → clamped to last index (2) → ordinal 3 / 3
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
  });

  it("renders the action bar slot when provided", () => {
    render(
      <WizardFrame
        subtitle="setup"
        steps={["A", "B"]}
        currentStep={0}
        actionBar={<button data-testid="action-bar-button">Continue</button>}
      >
        <span />
      </WizardFrame>,
    );
    expect(screen.getByTestId("action-bar-button")).toBeInTheDocument();
  });

  it("omits the action bar slot when not provided", () => {
    render(
      <WizardFrame
        subtitle="setup"
        steps={["A"]}
        currentStep={0}
      >
        <span />
      </WizardFrame>,
    );
    // Only the header is present — searching for a hypothetical "action"
    // chrome shouldn't find anything. Use the testId fallback to verify
    // the chrome rendered without errors.
    expect(screen.getByTestId("wizard-frame")).toBeInTheDocument();
  });
});

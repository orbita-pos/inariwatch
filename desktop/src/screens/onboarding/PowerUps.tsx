import { PowerUpToggles } from "@/components/PowerUpToggles";
import { Button } from "@/components/ui";
import { useOnboarding } from "@/lib/store/onboarding";

export function OnboardingPowerUps() {
  const setStep = useOnboarding((s) => s.setStep);

  return (
    <div
      data-testid="onboarding-step-powerups"
      className="flex flex-col items-center gap-6 max-w-xl mx-auto py-10 px-4"
    >
      <header className="text-center max-w-md">
        <h1 className="font-[var(--font-serif)] text-3xl mb-2">Power-ups</h1>
        <p className="text-sm text-[var(--muted)]">
          Each toggle is optional — you can change any of these later in Settings.
        </p>
      </header>

      <PowerUpToggles />

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setStep("drop")}>
          ← Back
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => setStep("ready")}
          data-testid="onboarding-powerups-continue"
        >
          Continue
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStep("ready")}
          data-testid="onboarding-powerups-skip"
        >
          Skip all
        </Button>
      </div>
    </div>
  );
}

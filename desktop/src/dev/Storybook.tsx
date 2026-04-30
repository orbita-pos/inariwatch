import { CommandPalette } from "@/components/CommandPalette";
import { Button, Dialog, Input, KbdHint, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { useAppState } from "@/lib/store/useAppState";

/**
 * "Storybook"-style component browser at /dev/components. Manual visual
 * smoke without needing `tauri dev` — opening dev.html in a browser is
 * enough to see every primitive in both light + dark mode.
 *
 * Intentionally NO real data wiring; this is a static gallery.
 */
export function Storybook() {
  const themeMode = useAppState((s) => s.themeMode);
  const setThemeMode = useAppState((s) => s.setThemeMode);

  return (
    <div className="min-h-full p-8 max-w-[960px] mx-auto">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-[var(--font-serif)] text-2xl mb-1">
            Inari Live design system
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Visual gallery — Session 14 primitives.
          </p>
        </div>
        <Tabs value={themeMode} onValueChange={(v) => setThemeMode(v as typeof themeMode)}>
          <TabsList>
            <TabsTrigger value="auto">Auto</TabsTrigger>
            <TabsTrigger value="light">Light</TabsTrigger>
            <TabsTrigger value="dark">Dark</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <section className="mb-10">
        <h2 className="text-sm uppercase text-[var(--muted)] mb-3">Buttons</h2>
        <div className="flex flex-wrap gap-3 items-center">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" size="lg">Large</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm uppercase text-[var(--muted)] mb-3">Input + Kbd</h2>
        <div className="flex gap-3 items-center max-w-md">
          <Input placeholder="Type something…" />
          <KbdHint>⌘ K</KbdHint>
          <KbdHint>ESC</KbdHint>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm uppercase text-[var(--muted)] mb-3">Dialog</h2>
        <Dialog
          trigger={<Button variant="primary">Open dialog</Button>}
          title="Sample dialog"
          description="Radix Dialog wrapped in our chrome."
        >
          <p className="text-sm text-[var(--text)]">
            The dialog overlay uses the locked OKLCH palette + the design-token shadow.
          </p>
        </Dialog>
      </section>

      <section className="mb-10">
        <h2 className="text-sm uppercase text-[var(--muted)] mb-3">
          Command palette
        </h2>
        <CommandPaletteToggle />
      </section>
    </div>
  );
}

function CommandPaletteToggle() {
  return (
    <>
      <p className="text-sm text-[var(--muted)] mb-2">
        Press <KbdHint>⌘ K</KbdHint> to open the global palette.
      </p>
      <CommandPalette />
    </>
  );
}

import { PermissionPanel } from "@/components/permissions/PermissionPanel";

/**
 * Settings → Permissions sub-tab. Hosts the `PermissionPanel`
 * component verbatim — keeping the screen-level shell separate from
 * the component so deep-links via `inari://navigate?route=settings`
 * + the existing rail-based router land in a known wrapper.
 */
export function SettingsPermissions() {
  return (
    <div data-testid="settings-permissions" className="max-w-3xl">
      <PermissionPanel />
    </div>
  );
}

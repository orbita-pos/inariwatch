/**
 * ProGate — Legacy component.
 *
 * InariWatch is now 100% Free SaaS, so there are no Pro-gated features.
 * This component is kept as a pass-through to avoid breaking imports,
 * but it always renders children regardless of plan.
 */
export function ProGate({
  children,
}: {
  isPro?: boolean;
  feature?: string;
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

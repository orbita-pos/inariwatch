/**
 * ProGate — Legacy component.
 *
 * InariWatch is in beta — all Pro features are available to everyone.
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

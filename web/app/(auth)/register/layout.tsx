import type { Metadata } from "next";

export const metadata: Metadata = {
  title:       "Create Account",
  description: "Create your free InariWatch account and start monitoring GitHub, Vercel, and Sentry in minutes.",
  robots:      { index: false, follow: false },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

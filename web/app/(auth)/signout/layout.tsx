import type { Metadata } from "next";

export const metadata: Metadata = {
  title:       "Sign Out",
  description: "Sign out of your InariWatch account.",
  robots:      { index: false, follow: false },
};

export default function SignOutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

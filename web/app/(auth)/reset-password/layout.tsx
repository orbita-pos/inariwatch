import type { Metadata } from "next";

export const metadata: Metadata = {
  title:       "Set New Password",
  description: "Set a new password for your InariWatch account.",
  robots:      { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

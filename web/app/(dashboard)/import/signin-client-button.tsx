"use client";

import { signIn } from "next-auth/react";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignInClientButton() {
  return (
    <Button
      variant="primary"
      size="lg"
      className="w-full gap-2"
      onClick={() => {
        void signIn("github", { callbackUrl: "/import" });
      }}
    >
      <Github className="h-4 w-4" /> Continue with GitHub
    </Button>
  );
}

"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ExportButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => {
        window.location.href = "/api/alerts/export";
      }}
    >
      <Download className="h-3.5 w-3.5" />
      Export CSV
    </Button>
  );
}

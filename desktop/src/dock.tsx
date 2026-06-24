import React from "react";
import { createRoot } from "react-dom/client";

import { DockShell } from "@/components/dock/DockShell";
import { AppProviders } from "@/lib/boot";

const container = document.getElementById("root");
if (!container) throw new Error("dock.tsx: #root not found");

createRoot(container).render(
  <React.StrictMode>
    <AppProviders>
      <DockShell />
    </AppProviders>
  </React.StrictMode>,
);

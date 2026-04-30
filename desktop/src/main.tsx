import React from "react";
import { createRoot } from "react-dom/client";

import { MainShell } from "@/components/main/MainShell";
import { AppProviders } from "@/lib/boot";

const container = document.getElementById("root");
if (!container) throw new Error("main.tsx: #root not found");

createRoot(container).render(
  <React.StrictMode>
    <AppProviders>
      <MainShell />
    </AppProviders>
  </React.StrictMode>,
);

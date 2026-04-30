import React from "react";
import { createRoot } from "react-dom/client";

import { Storybook } from "@/dev/Storybook";
import { AppProviders } from "@/lib/boot";

const container = document.getElementById("root");
if (!container) throw new Error("dev/main.tsx: #root not found");

createRoot(container).render(
  <React.StrictMode>
    <AppProviders>
      <Storybook />
    </AppProviders>
  </React.StrictMode>,
);

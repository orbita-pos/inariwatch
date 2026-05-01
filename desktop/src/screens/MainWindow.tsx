import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Sidebar } from "@/components/sidebar/Sidebar";
import { ScrollArea } from "@/components/ui";
import { useMainWindow, type MainRoute } from "@/lib/store/mainWindow";
import { MainActivity } from "@/screens/main/Activity";
import { MainInbox } from "@/screens/main/Inbox";
import { MainMemory } from "@/screens/main/Memory";
import { MainPatterns } from "@/screens/main/Patterns";
import { Settings } from "@/screens/Settings";

interface NavigatePayload {
  target: string;
  route: string;
}

const ROUTE_FROM_PATH: Record<string, MainRoute> = {
  "/":          "inbox",
  "/inbox":     "inbox",
  "/activity":  "activity",
  "/memory":    "memory",
  "/patterns":  "patterns",
  "/settings":  "settings",
};

export function MainWindow() {
  const route = useMainWindow((s) => s.route);
  const setRoute = useMainWindow((s) => s.setRoute);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<NavigatePayload>("inari://navigate", (msg) => {
      if (msg.payload.target !== "main") return;
      const next = ROUTE_FROM_PATH[msg.payload.route];
      if (next) setRoute(next);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // jsdom or no Tauri runtime — swallow.
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [setRoute]);

  return (
    <div data-testid="main-window" data-route={route} className="h-full w-full flex">
      <Sidebar />
      <ScrollArea className="flex-1 h-full">
        {route === "inbox"    ? <MainInbox /> : null}
        {route === "activity" ? <MainActivity /> : null}
        {route === "memory"   ? <MainMemory /> : null}
        {route === "patterns" ? <MainPatterns /> : null}
        {route === "settings" ? <Settings /> : null}
      </ScrollArea>
    </div>
  );
}

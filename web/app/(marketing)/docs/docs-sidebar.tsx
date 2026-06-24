"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

interface NavItem {
  id: string;
  label: string;
}
interface NavGroup {
  group: string;
  items: NavItem[];
}

export function DocsSidebar({ nav }: { nav: NavGroup[] }) {
  const allIds = nav.flatMap((g) => g.items.map((i) => i.id));
  const [active, setActive] = useState<string>(allIds[0] ?? "");
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  const userScrolledRef = useRef(false);

  // Track which heading is currently in view via IntersectionObserver.
  // We pick the topmost intersecting heading; if none intersect (e.g. mid-section),
  // we fall back to the last heading whose top is above the viewport top + offset.
  useEffect(() => {
    const headings = allIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    // Offset matches the marketing nav height (h-16 = 64px) plus a touch of breathing room.
    const TOP_OFFSET = 96;

    function computeActive() {
      let current: string = headings[0].id;
      for (const h of headings) {
        const top = h.getBoundingClientRect().top;
        if (top - TOP_OFFSET <= 0) {
          current = h.id;
        } else {
          break;
        }
      }
      // Edge case: scrolled to bottom of page — pin to last heading
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 4) {
        current = headings[headings.length - 1].id;
      }
      setActive((prev) => (prev === current ? prev : current));
    }

    computeActive();
    const onScroll = () => {
      userScrolledRef.current = true;
      computeActive();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", computeActive, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", computeActive);
    };
  }, [allIds]);

  // Keep the active link visible inside the sidebar's own scroll container.
  useEffect(() => {
    if (!userScrolledRef.current) return;
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <aside className="docs-sidebar hidden lg:block w-52 shrink-0 sticky top-20 h-[calc(100vh-5rem)] overflow-y-auto">
      <div className="py-6 space-y-6">
        {nav.map((section) => (
          <div key={section.group}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-fg-base/80">
              {section.group}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = item.id === active;
                return (
                  <li key={item.id}>
                    <a
                      ref={isActive ? activeRef : undefined}
                      href={`#${item.id}`}
                      aria-current={isActive ? "location" : undefined}
                      className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm transition-colors ${
                        isActive
                          ? "bg-inari-accent/10 text-inari-accent font-medium"
                          : "text-fg-base/70 hover:bg-surface-inner hover:text-fg-strong"
                      }`}
                    >
                      <ChevronRight
                        className={`h-3 w-3 shrink-0 transition-opacity ${
                          isActive ? "opacity-100 text-inari-accent" : "opacity-40"
                        }`}
                        aria-hidden="true"
                      />
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  );
}

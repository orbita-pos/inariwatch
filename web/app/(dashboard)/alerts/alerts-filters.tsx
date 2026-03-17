"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { SearchInput } from "./search-input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface AlertsFiltersProps {
  severity: string;
  status:   string;
  source:   string;
}

export function AlertsFilters({ severity, status, source }: AlertsFiltersProps) {
  const router     = useRouter();
  const pathname   = usePathname();
  const searchParams = useSearchParams();

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return (
    <div className="space-y-3">
      <SearchInput />

      <div className="flex flex-wrap gap-2">
        <Select value={severity} onValueChange={(v) => updateParam("severity", v)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any severity</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={(v) => updateParam("status", v)}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={(v) => updateParam("source", v)}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any source</SelectItem>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="vercel">Vercel</SelectItem>
            <SelectItem value="sentry">Sentry</SelectItem>
            <SelectItem value="uptime">Uptime</SelectItem>
            <SelectItem value="postgres">Postgres</SelectItem>
            <SelectItem value="npm">npm</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

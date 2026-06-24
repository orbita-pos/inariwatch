import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { shortHash } from "@/lib/inari-hash";

interface ResolvedAlert {
  type: "alert";
  id: string;
  inariHash: string;
  title: string;
  severity: "critical" | "warning" | "info";
  alertType: string;
  isResolved: boolean;
  createdAt: string;
  project: { id: string; name: string };
  url: string;
}

async function resolve(hash: string): Promise<ResolvedAlert | null> {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    "https://app.inariwatch.com";
  try {
    const res = await fetch(`${appUrl}/api/r/${encodeURIComponent(hash)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ hash: string }>;
}): Promise<Metadata> {
  const { hash } = await params;
  const data = await resolve(hash);
  if (!data) {
    return { title: "Not found · InariWatch" };
  }

  const severityLabel =
    data.severity === "critical"
      ? "🔴 Critical"
      : data.severity === "warning"
        ? "🟡 Warning"
        : "🔵 Info";
  const status = data.isResolved ? "Resolved" : "Open";

  return {
    title: `${data.title} · InariWatch`,
    description: `${severityLabel} · ${status} · ${data.project.name}`,
    openGraph: {
      title: data.title,
      description: `${severityLabel} alert in ${data.project.name} · ${status}`,
      siteName: "InariWatch",
      type: "article",
    },
    twitter: {
      card: "summary",
      title: data.title,
      description: `${severityLabel} · ${data.project.name} · ${status}`,
    },
  };
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border border-red-500/20",
  warning: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
  info: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
};

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-400",
  warning: "bg-yellow-400",
  info: "bg-blue-400",
};

export default async function InariHashPage({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = await params;
  const data = await resolve(hash);
  if (!data) notFound();

  const short = shortHash(data.inariHash ?? hash);
  const resolvedDate = new Date(data.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Hash pill */}
        <div className="flex items-center gap-2 mb-4">
          <span className="font-mono text-xs text-zinc-500">
            inari:{data.type}:
          </span>
          <code className="font-mono text-xs text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded">
            {short}
          </code>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-4">
          {/* Header row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-white font-medium leading-snug line-clamp-3">
                {data.title}
              </p>
            </div>
            <span
              className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${SEVERITY_STYLES[data.severity]}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[data.severity]}`}
              />
              {data.severity}
            </span>
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>{data.project.name}</span>
            <span>·</span>
            <span>{resolvedDate}</span>
            <span>·</span>
            <span
              className={
                data.isResolved ? "text-emerald-400" : "text-zinc-400"
              }
            >
              {data.isResolved ? "Resolved" : "Open"}
            </span>
          </div>

          {/* CTA */}
          <div className="pt-1">
            <Link
              href={data.url}
              className="inline-flex items-center gap-2 text-sm font-medium bg-white text-black px-4 py-2 rounded-lg hover:bg-zinc-100 transition-colors"
            >
              Open in Dashboard
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </Link>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-zinc-600 mt-4">
          Shared via{" "}
          <Link href="https://inariwatch.com" className="hover:text-zinc-400 transition-colors">
            InariWatch
          </Link>
        </p>
      </div>
    </div>
  );
}

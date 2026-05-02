/**
 * Sesión 29 — POST /api/verify
 *
 * Server-side counterpart to the `/verify` marketing page. Accepts a
 * receipt as either:
 *   • application/json — raw `.eap.json` body
 *   • multipart/form-data with a `file` field
 *   • application/x-www-form-urlencoded with a `receipt` field
 *
 * Returns the same [`VerifySummary`] shape the client-side path uses.
 * Defense-in-depth: the verifier on `/verify` runs in the browser, so
 * an offline auditor / compliance integration can call this endpoint
 * to get an identical verdict from a server they trust.
 *
 * No login, no auth, no rate limit. Pure CPU; the entire pipeline runs
 * without any DB or network I/O. CORS is open (`*`) for cross-origin
 * audit tooling — the worst a caller can do is verify a receipt they
 * already have.
 *
 * Per Sesión 28 + 29 disclosure contract, the response includes a
 * `disclosure` field stating exactly what the signature commits to.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseReceipt, parseErrorReason, verify } from "@/lib/eap-verify";
import type {
  EapReceipt,
  ParseError,
  VerifyOutcome,
} from "@/lib/eap-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 1 MB — `.eap.json` files are tiny (typical: 2-5 KB). */
const MAX_BODY_BYTES = 1024 * 1024;

const DISCLOSURE = [
  "The Ed25519 signature commits to SHA-256(receipt_id). The Merkle root commits to the recorded events.",
  "Metadata fields (prompt_hash, tools, files_read, model, timestamp) are display-only and NOT cryptographically committed by the signature.",
].join(" ");

interface VerifyResponseBody {
  ok: boolean;
  outcome: VerifyOutcome;
  receipt: EapReceipt | null;
  parseError: ParseError | null;
  disclosure: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await readReceiptBody(req);
  if (raw.kind === "error") {
    return jsonResponse({ status: raw.status, message: raw.message });
  }

  return runVerify(raw.text);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Convenience: GET /api/verify?json=<urlencoded JSON>. The page uses
  // the POST path; this is here so a curl-friendly auditor can hit the
  // endpoint without crafting a body. Same shape on success/failure.
  // Use the underlying URL string instead of `req.nextUrl` so test
  // doubles backed by plain `Request` objects work without polyfilling
  // Next-specific fields.
  const json = new URL(req.url).searchParams.get("json");
  if (!json) {
    return jsonResponse({
      status: 400,
      message:
        "POST a `.eap.json` body, or pass ?json=<urlencoded JSON> on GET",
    });
  }
  if (json.length > MAX_BODY_BYTES) {
    return jsonResponse({ status: 413, message: "receipt too large" });
  }
  return runVerify(json);
}

function runVerify(rawJson: string): NextResponse {
  const parsed = parseReceipt(rawJson);
  if (!("version" in parsed)) {
    const body: VerifyResponseBody = {
      ok: false,
      outcome: { kind: "malformed", reason: parseErrorReason(parsed) },
      receipt: null,
      parseError: parsed,
      disclosure: DISCLOSURE,
    };
    return new NextResponse(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const outcome = verify(parsed);
  const body: VerifyResponseBody = {
    ok: outcome.kind === "signed" || outcome.kind === "merkle-only",
    outcome,
    receipt: parsed,
    parseError: null,
    disclosure: DISCLOSURE,
  };
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

type ReadResult =
  | { kind: "ok"; text: string }
  | { kind: "error"; status: number; message: string };

async function readReceiptBody(req: NextRequest): Promise<ReadResult> {
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();

  if (ctype.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return {
        kind: "error",
        status: 400,
        message: "could not parse multipart body",
      };
    }
    const file = form.get("file");
    if (file instanceof File) {
      if (file.size > MAX_BODY_BYTES) {
        return { kind: "error", status: 413, message: "receipt too large" };
      }
      const text = await file.text();
      return { kind: "ok", text };
    }
    const receipt = form.get("receipt");
    if (typeof receipt === "string") {
      if (receipt.length > MAX_BODY_BYTES) {
        return { kind: "error", status: 413, message: "receipt too large" };
      }
      return { kind: "ok", text: receipt };
    }
    return {
      kind: "error",
      status: 400,
      message: "multipart body must include a `file` or `receipt` field",
    };
  }

  if (ctype.startsWith("application/x-www-form-urlencoded")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return {
        kind: "error",
        status: 400,
        message: "could not parse form body",
      };
    }
    const receipt = form.get("receipt");
    if (typeof receipt === "string") {
      if (receipt.length > MAX_BODY_BYTES) {
        return { kind: "error", status: 413, message: "receipt too large" };
      }
      return { kind: "ok", text: receipt };
    }
    return {
      kind: "error",
      status: 400,
      message: "form body must include a `receipt` field",
    };
  }

  // Default: treat the body as raw JSON text. Works for application/json
  // and for `curl --data-binary @file.eap.json` calls without a content
  // type set.
  let text: string;
  try {
    text = await req.text();
  } catch {
    return {
      kind: "error",
      status: 400,
      message: "could not read request body",
    };
  }
  if (!text) {
    return { kind: "error", status: 400, message: "empty body" };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { kind: "error", status: 413, message: "receipt too large" };
  }
  return { kind: "ok", text };
}

function jsonResponse(opts: { status: number; message: string }): NextResponse {
  return new NextResponse(
    JSON.stringify({ ok: false, error: opts.message, disclosure: DISCLOSURE }),
    {
      status: opts.status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    },
  );
}

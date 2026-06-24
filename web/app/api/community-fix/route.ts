import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { lookupCommunityFix } from "@/lib/ai/community-fix-lookup";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json(null, { status: 401 });
  }

  const fingerprint = req.nextUrl.searchParams.get("fingerprint");
  if (!fingerprint) return NextResponse.json(null);

  const match = await lookupCommunityFix(fingerprint);
  return NextResponse.json(match);
}

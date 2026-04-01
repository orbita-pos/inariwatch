import { NextResponse } from "next/server";

/**
 * GET /api/mobile/version
 * Returns minimum required app version. The app checks on launch
 * and shows "Update required" if currentVersion < minVersion.
 */
export async function GET() {
  return NextResponse.json({
    minVersion: "1.0.0",
    latestVersion: "1.0.0",
    downloadUrl: "https://app.inariwatch.com/download",
    updateRequired: false,
  });
}

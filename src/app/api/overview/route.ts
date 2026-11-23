import { NextResponse } from "next/server";
import { getOverview } from "@/lib/session-sync";

// GET /api/overview — Sessions and LiveKit rooms merged into one list, after
// reconciling the two (see session-sync.ts)
export async function GET() {
  try {
    return NextResponse.json(await getOverview());
  } catch (error) {
    console.error("Error building overview:", error);
    return NextResponse.json(
      { error: "Failed to load rooms: " + (error as Error).message },
      { status: 500 }
    );
  }
}

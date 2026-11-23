import { NextRequest, NextResponse } from "next/server";
import { getRoomServiceClient } from "@/lib/livekit-admin";
import TranslationSessionManager from "@/lib/translation-session-manager";

// DELETE /api/rooms/[roomName] — Force-close a LiveKit room and tear down
// any translation bridges/session state tied to it
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ roomName: string }> }
) {
  try {
    const { roomName } = await params;

    // Stop bridges first so they don't fight the room deletion
    await TranslationSessionManager.getInstance().removeAllTranslations(
      roomName
    );
    await getRoomServiceClient()
      .deleteRoom(roomName)
      .catch(() => {
        // Room already gone — state cleanup above is what matters
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting room:", error);
    return NextResponse.json(
      { error: "Failed to delete room: " + (error as Error).message },
      { status: 500 }
    );
  }
}

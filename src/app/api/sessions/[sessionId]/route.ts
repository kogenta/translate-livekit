import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";
import { getRoomServiceClient } from "@/lib/livekit-admin";

// GET /api/sessions/:sessionId — Get session info
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const manager = TranslationSessionManager.getInstance();
  const session = manager.getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const translations = manager.getActiveTranslations(sessionId);

  return NextResponse.json({
    ...session,
    translations,
  });
}

// DELETE /api/sessions/:sessionId — End a session and clean up all bridges
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  try {
    const manager = TranslationSessionManager.getInstance();

    await manager.removeAllTranslations(sessionId);
    // Close the room too: while the organizer stays connected, the overview
    // sync would adopt the room right back as a new session
    await getRoomServiceClient()
      .deleteRoom(sessionId)
      .catch(() => {
        // No room (never joined, or already gone) — the session record is gone
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(`Error ending session ${sessionId}:`, error);
    return NextResponse.json(
      { error: "Failed to end session: " + (error as Error).message },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";

// POST /api/sessions/:sessionId/audio-language — Hybrid mode: choose which
// language of the pair gets the translated voice (the room's one Live
// session); the other side stays subtitles only
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { language } = await req.json().catch(() => ({}));

  if (!language) {
    return NextResponse.json({ error: "Missing language" }, { status: 400 });
  }

  const manager = TranslationSessionManager.getInstance();
  if (!manager.getSession(sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const config = manager.getAudioConfig(sessionId);
  if (config.mode !== "hybrid" || !config.pair.includes(language)) {
    return NextResponse.json(
      { error: `Voice language can only be switched between ${config.pair.join(", ")} in hybrid mode` },
      { status: 400 }
    );
  }

  try {
    await manager.setAudioLanguage(sessionId, language);
    return NextResponse.json({ audio: manager.getAudioConfig(sessionId) });
  } catch (error) {
    console.error("Error switching voice language:", error);
    return NextResponse.json(
      { error: "Failed to switch voice language: " + (error as Error).message },
      { status: 500 }
    );
  }
}

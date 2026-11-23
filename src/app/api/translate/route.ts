import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";
import { getRoomServiceClient } from "@/lib/livekit-admin";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "@/lib/languages";

function unsupportedLanguage(language: unknown) {
  return NextResponse.json(
    {
      error: `Unsupported language "${String(language)}"`,
      supported: SUPPORTED_LANGUAGES.map((l) => l.code),
    },
    { status: 400 }
  );
}

// POST /api/translate — Request a translation stream for a language
export async function POST(req: NextRequest) {
  try {
    const { sessionId, targetLanguage, previousLanguage } = await req.json();

    if (!sessionId || !targetLanguage) {
      return NextResponse.json(
        { error: "Missing sessionId or targetLanguage" },
        { status: 400 }
      );
    }

    // "original" = listen to the organizer directly, no translation
    if (targetLanguage !== "original" && !isSupportedLanguage(targetLanguage)) {
      return unsupportedLanguage(targetLanguage);
    }

    const manager = TranslationSessionManager.getInstance();
    let session = manager.getSession(sessionId);

    if (!session) {
      // Server restarted (or HMR wiped state) but the LiveKit room may still
      // be live — rebuild the session record from the room's organizer.
      try {
        const svc = getRoomServiceClient();
        const participants = await svc.listParticipants(sessionId); // throws if room gone
        const organizer = participants.find((p) =>
          p.identity.startsWith("organizer-")
        );
        if (organizer) {
          console.warn(
            `[translate] Session ${sessionId} missing from manager — rebuilt from room organizer ${organizer.identity}`
          );
          session = manager.createSession(sessionId, organizer.identity);
        }
      } catch {
        // Room doesn't exist — genuine 404 below
      }
    }

    if (!session) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    // Unsubscribe from the previous language if switching (an unsupported
    // one never got a bridge, so there is nothing to release)
    if (isSupportedLanguage(previousLanguage)) {
      await manager.unsubscribe(sessionId, previousLanguage);
    }

    // Skip translation for the original language (no bridge needed)
    if (targetLanguage === "original") {
      return NextResponse.json({
        translatorIdentity: null,
        status: "original",
        message: "Using original audio",
      });
    }

    // Get or create the translation bridge (or, in hybrid mode, a text
    // route through the voice language's bridge)
    const { bridge, audio } = await manager.subscribe(
      sessionId,
      targetLanguage,
      session.organizerIdentity
    );

    return NextResponse.json({
      // null = subtitles only: there is no audio track for this language
      translatorIdentity: audio ? bridge.identity : null,
      audio,
      status: bridge.status,
      targetLanguage,
    });
  } catch (error) {
    console.error("Error requesting translation:", error);
    return NextResponse.json(
      { error: "Failed to start translation: " + (error as Error).message },
      { status: 500 }
    );
  }
}

// DELETE /api/translate — Unsubscribe from a translation (e.g. on disconnect)
export async function DELETE(req: NextRequest) {
  try {
    const { sessionId, targetLanguage } = await req.json();

    if (!sessionId || !targetLanguage) {
      return NextResponse.json(
        { error: "Missing sessionId or targetLanguage" },
        { status: 400 }
      );
    }

    if (!isSupportedLanguage(targetLanguage)) {
      return unsupportedLanguage(targetLanguage);
    }

    const manager = TranslationSessionManager.getInstance();
    await manager.unsubscribe(sessionId, targetLanguage);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error unsubscribing:", error);
    return NextResponse.json(
      { error: "Failed to unsubscribe" },
      { status: 500 }
    );
  }
}

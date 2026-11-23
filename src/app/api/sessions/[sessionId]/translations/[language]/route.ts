import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";

// DELETE /api/sessions/[sessionId]/translations/[language] — Force-stop one
// translation bridge regardless of its subscriber refcount (admin action)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; language: string }> }
) {
  try {
    const { sessionId, language } = await params;
    await TranslationSessionManager.getInstance().removeTranslation(
      sessionId,
      language
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error removing translation:", error);
    return NextResponse.json(
      { error: "Failed to remove translation: " + (error as Error).message },
      { status: 500 }
    );
  }
}

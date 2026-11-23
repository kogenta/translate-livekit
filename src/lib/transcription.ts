/**
 * Shared transcription wire format and client-side grouping logic.
 *
 * Pure TypeScript — no React or LiveKit imports — so it can be used by both
 * the server-side TranslationBridge (producer) and the watch page (consumer).
 */

export type TranscriptionKind = "original" | "translated";

/** Payload published on the LiveKit data channel, topic "transcription". */
export interface TranscriptionMessage {
  type: "transcription";
  /** Bridge target language — set for both kinds so clients can filter by selected language. */
  language: string;
  /** `${lang}-${bridgeTag}-${n}` — all chunks of one utterance (original + translated) share this. */
  segmentId: string;
  /** Absent means "translated" (backward compatibility with older payloads). */
  kind?: TranscriptionKind;
  text: string;
  final: boolean;
  /** Replace this kind's text for the segment instead of appending to it. */
  replace?: boolean;
  /** Date.now() on the bridge when the chunk was published. */
  timestamp: number;
}

/** One utterance: original text paired with its translation. */
export interface TranscriptGroup {
  id: string;
  /** Target language of the bridge that produced this utterance. */
  language: string;
  original: string;
  translated: string;
  final: boolean;
  /** Timestamp of the first chunk received for this utterance. */
  timestamp: number;
}

// Every bridge transcribes every utterance, but the split view shows each
// utterance from only one of them (see SplitTranscript), so the cap is sized
// for ~2 bridges' worth of groups.
export const TRANSCRIPT_CAP = 150;

/**
 * Fold a transcription chunk into the group list. Chunks sharing a segmentId
 * are appended into the same group, routed by kind. Only translated chunks
 * decide finality (the output stream is what ends a turn).
 */
export function reduceTranscription(
  prev: TranscriptGroup[],
  msg: TranscriptionMessage,
  cap: number = TRANSCRIPT_CAP
): TranscriptGroup[] {
  const kind: TranscriptionKind = msg.kind ?? "translated";
  const idx = prev.findIndex((g) => g.id === msg.segmentId);
  if (idx >= 0) {
    const updated = [...prev];
    const g = updated[idx];
    updated[idx] = {
      ...g,
      original:
        kind === "original" ? (msg.replace ? "" : g.original) + msg.text : g.original,
      translated:
        kind === "translated"
          ? (msg.replace ? "" : g.translated) + msg.text
          : g.translated,
      final: kind === "translated" ? msg.final : g.final,
    };
    return updated;
  }
  return [
    ...prev,
    {
      id: msg.segmentId,
      language: msg.language,
      original: kind === "original" ? msg.text : "",
      translated: kind === "translated" ? msg.text : "",
      final: kind === "translated" && msg.final,
      timestamp: msg.timestamp,
    },
  ].slice(-cap);
}

/** Format an elapsed duration in milliseconds as zero-padded mm:ss. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

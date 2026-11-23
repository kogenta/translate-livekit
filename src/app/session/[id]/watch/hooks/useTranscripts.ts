"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RoomEvent, type Room } from "livekit-client";
import {
  formatElapsed,
  reduceTranscription,
  type TranscriptGroup,
  type TranscriptionMessage,
} from "@/lib/transcription";

/**
 * Subscribes to the "transcription" data channel and folds incoming chunks
 * from the bridges for `languages` into utterance groups (original +
 * translated text paired by segmentId). Deciding which groups to show is
 * left to the view — see SplitTranscript. `getTranscript()` returns every
 * group received this session, for the transcript download.
 */
export function useTranscripts(room: Room | undefined, languages: string[]) {
  const [groups, setGroups] = useState<TranscriptGroup[]>([]);
  // Elapsed-time base: first message's timestamp. Never reset so time
  // badges stay monotonic across pair changes.
  const sessionBaseRef = useRef<number | null>(null);
  const languagesRef = useRef(languages);
  // Uncapped copy of `groups` (which keeps only the last TRANSCRIPT_CAP).
  // A ref: it changes with every chunk but is only read on download.
  const archiveRef = useRef<TranscriptGroup[]>([]);

  useEffect(() => {
    languagesRef.current = languages;
  }, [languages]);

  useEffect(() => {
    if (!room) return;

    const handleData = (
      payload: Uint8Array,
      participant: unknown,
      kind: unknown,
      topic: string | undefined
    ) => {
      if (topic !== "transcription") return;

      try {
        const data = JSON.parse(
          new TextDecoder().decode(payload)
        ) as TranscriptionMessage;
        if (data.type !== "transcription") return;
        if (!languagesRef.current.includes(data.language)) return;

        if (sessionBaseRef.current === null) {
          sessionBaseRef.current = data.timestamp;
        }
        archiveRef.current = reduceTranscription(archiveRef.current, data, Infinity);
        setGroups((prev) => reduceTranscription(prev, data));
      } catch {
        // Not a JSON transcription message
      }
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room]);

  const clear = useCallback(() => {
    archiveRef.current = [];
    setGroups([]);
  }, []);

  const getTranscript = useCallback(
    () => ({ groups: archiveRef.current, startedAt: sessionBaseRef.current }),
    []
  );

  const formatTime = useCallback(
    (g: TranscriptGroup) =>
      formatElapsed(g.timestamp - (sessionBaseRef.current ?? g.timestamp)),
    []
  );

  return { groups, clear, formatTime, getTranscript };
}

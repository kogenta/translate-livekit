/**
 * Server-side LiveKit admin helper: RoomServiceClient for listing rooms,
 * listing participants, and deleting rooms. Used by the session self-heal
 * path and the admin APIs.
 */

import { RoomServiceClient } from "livekit-server-sdk";

export function getRoomServiceClient(): RoomServiceClient {
  const url =
    process.env.LIVEKIT_URL ||
    process.env.NEXT_PUBLIC_LIVEKIT_URL ||
    "ws://localhost:7880";
  // RoomServiceClient talks HTTP(S), not WS(S)
  const host = url.replace(/^ws/, "http");
  return new RoomServiceClient(
    host,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!
  );
}

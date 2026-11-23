/**
 * One merged view of the in-memory sessions and the LiveKit rooms, plus the
 * reconciliation that keeps them in step. The two drift apart because
 * sessions live in this process and rooms live in LiveKit:
 *
 *  - server restart / HMR: the room (and its organizer) survives, the
 *    session record is gone  -> adopt it back from the room's organizer
 *  - session created but its organizer never joined: the record exists, the
 *    room never does  -> drop it once it is clearly abandoned
 *  - room with no session and no organizer: nobody can broadcast into it  ->
 *    reported as "orphaned" for an operator to delete (never auto-deleted,
 *    an attendee may still be connected)
 */

import { getRoomServiceClient } from "@/lib/livekit-admin";
import TranslationSessionManager, {
  type TranslationInfo,
} from "@/lib/translation-session-manager";

/** A session with no LiveKit room and no bridges is dropped after this. */
export const STALE_SESSION_MS = 10 * 60_000;

export type RoomStatus =
  /** Organizer connected. */
  | "live"
  /** Session exists, organizer not connected (yet). */
  | "waiting"
  /** LiveKit room without a session record and without an organizer. */
  | "orphaned"
  /** LiveKit unreachable, so presence is not known. */
  | "unknown";

export interface OverviewParticipant {
  identity: string;
  isOrganizer: boolean;
  isTranslator: boolean;
}

export interface RoomOverview {
  /** Session id = LiveKit room name. */
  id: string;
  status: RoomStatus;
  session: {
    organizerIdentity: string;
    createdAt: string;
    audioLanguage: string;
    translations: TranslationInfo[];
  } | null;
  /** null when LiveKit has no such room, or could not be reached. */
  room: {
    numParticipants: number;
    creationTime: number;
    participants: OverviewParticipant[];
  } | null;
}

export interface Overview {
  /** False when LiveKit could not be reached; rows then carry sessions only. */
  livekit: boolean;
  rooms: RoomOverview[];
}

export async function getOverview(): Promise<Overview> {
  const manager = TranslationSessionManager.getInstance();
  await manager.pruneDeadBridges();

  let liveRooms: {
    name: string;
    numParticipants: number;
    creationTime: number;
    participants: OverviewParticipant[];
  }[] | null = null;

  try {
    const svc = getRoomServiceClient();
    const rooms = await svc.listRooms();
    liveRooms = await Promise.all(
      rooms.map(async (room) => {
        const participants = await svc
          .listParticipants(room.name)
          .catch(() => []);
        return {
          name: room.name,
          numParticipants: room.numParticipants,
          // proto fields are BigInt — JSON.stringify throws on them
          creationTime: Number(room.creationTime),
          participants: participants.map((p) => ({
            identity: p.identity,
            isOrganizer: p.identity.startsWith("organizer-"),
            isTranslator: p.identity.startsWith("translator-"),
          })),
        };
      })
    );
  } catch (error) {
    console.error("[session-sync] LiveKit unreachable:", error);
  }

  if (liveRooms) {
    await reconcile(manager, liveRooms);
  }

  const roomByName = new Map((liveRooms ?? []).map((r) => [r.name, r]));
  const ids = new Set<string>([
    ...manager.getAllSessions().map((s) => s.sessionId),
    ...roomByName.keys(),
  ]);

  const rows: RoomOverview[] = [];
  for (const id of ids) {
    const info = manager.getSession(id);
    const room = roomByName.get(id) ?? null;

    let status: RoomStatus;
    if (!liveRooms) status = "unknown";
    else if (!info) status = "orphaned";
    else if (room?.participants.some((p) => p.isOrganizer)) status = "live";
    else status = "waiting";

    rows.push({
      id,
      status,
      session: info
        ? {
            organizerIdentity: info.organizerIdentity,
            createdAt: info.createdAt.toISOString(),
            audioLanguage: info.audioLanguage,
            translations: manager.getActiveTranslations(id),
          }
        : null,
      room: room && {
        numParticipants: room.numParticipants,
        creationTime: room.creationTime,
        participants: room.participants,
      },
    });
  }

  return { livekit: liveRooms !== null, rooms: rows };
}

async function reconcile(
  manager: TranslationSessionManager,
  liveRooms: { name: string; creationTime: number; participants: OverviewParticipant[] }[]
): Promise<void> {
  const roomNames = new Set(liveRooms.map((r) => r.name));

  // Room with an organizer but no session record: adopt it
  for (const room of liveRooms) {
    if (manager.getSession(room.name)) continue;
    const organizer = room.participants.find((p) => p.isOrganizer);
    if (!organizer) continue;
    console.warn(
      `[session-sync] Room ${room.name} has no session — adopted from organizer ${organizer.identity}`
    );
    manager.createSession(
      room.name,
      organizer.identity,
      new Date(room.creationTime * 1000)
    );
  }

  // Session whose room never appeared (or is long gone), with nothing running
  for (const session of manager.getAllSessions()) {
    if (roomNames.has(session.sessionId)) continue;
    if (manager.getActiveTranslations(session.sessionId).length > 0) continue;
    if (Date.now() - session.createdAt.getTime() < STALE_SESSION_MS) continue;
    console.warn(
      `[session-sync] Session ${session.sessionId} has no room after ${STALE_SESSION_MS / 60000} min — dropped`
    );
    await manager.removeAllTranslations(session.sessionId);
  }
}

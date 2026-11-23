import { NextResponse } from "next/server";
import { getRoomServiceClient } from "@/lib/livekit-admin";

// GET /api/rooms — List LiveKit rooms with their participants
export async function GET() {
  try {
    const svc = getRoomServiceClient();
    const rooms = await svc.listRooms();

    const detailed = await Promise.all(
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

    return NextResponse.json({ rooms: detailed });
  } catch (error) {
    console.error("Error listing rooms:", error);
    return NextResponse.json(
      { error: "Failed to list rooms: " + (error as Error).message },
      { status: 500 }
    );
  }
}

"use client";

// NOTE: no auth — local demo only. Gate this route before any real deployment.

import { useCallback, useEffect, useState } from "react";
import type { BridgeStatus } from "@/lib/translation-bridge";
import type { Overview, RoomOverview, RoomStatus } from "@/lib/session-sync";

function statusClass(status: BridgeStatus): string {
  if (status === "active") return "status status--active";
  if (status === "starting") return "status status--waiting";
  return "status status--error";
}

const ROOM_STATUS: Record<RoomStatus, { label: string; className: string }> = {
  live: { label: "on air", className: "status status--active" },
  waiting: { label: "waiting for organizer", className: "status status--waiting" },
  orphaned: {
    label: "orphaned — no session record, no organizer",
    className: "status status--error",
  },
  unknown: { label: "LiveKit unreachable", className: "status" },
};

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Result of the last Kill / End / Delete; kept apart from the poll error,
  // which the next successful refresh clears
  const [actionError, setActionError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Sessions and LiveKit rooms arrive already merged and reconciled
      const res = await fetch("/api/overview");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setOverview(data as Overview);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Defer the initial fetch out of the effect body (setState-in-effect rule)
    const initial = setTimeout(refresh, 0);
    const interval = setInterval(refresh, 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [refresh]);

  // Run a destructive call and say so when it fails, instead of the row just
  // staying put with no explanation
  const act = async (label: string, url: string) => {
    try {
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setActionError(null);
    } catch (err) {
      setActionError(`${label} failed: ${(err as Error).message}`);
    }
    refresh();
  };

  const killBridge = (sessionId: string, language: string) => {
    if (!window.confirm(`Force-stop the ${language} bridge in ${sessionId}?`))
      return;
    return act(
      `Stopping ${language} bridge`,
      `/api/sessions/${sessionId}/translations/${language}`
    );
  };

  const endSession = (sessionId: string) => {
    if (
      !window.confirm(
        `End session ${sessionId}? Its bridges stop and the LiveKit room closes, disconnecting everyone in it.`
      )
    )
      return;
    return act("Ending session", `/api/sessions/${sessionId}`);
  };

  const deleteRoom = (roomName: string) => {
    if (
      !window.confirm(
        `Delete LiveKit room ${roomName}? All participants will be disconnected.`
      )
    )
      return;
    return act("Deleting room", `/api/rooms/${roomName}`);
  };

  const rows: RoomOverview[] = overview?.rooms ?? [];

  return (
    <div className="page page-top">
      <div className="container-wide enter">
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 32,
          }}
        >
          <div>
            <h1 className="display display-lg" style={{ marginBottom: 8 }}>
              <em>Admin</em>
            </h1>
            <p className="body-sm">
              Sessions and LiveKit rooms, kept in sync automatically
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={refresh}>
            Refresh
          </button>
        </div>

        {error && (
          <p className="status status--error" style={{ marginBottom: 16 }}>
            {error}
          </p>
        )}
        {actionError && (
          <p className="status status--error" style={{ marginBottom: 16 }}>
            {actionError}
          </p>
        )}
        {overview && !overview.livekit && (
          <p className="status status--waiting" style={{ marginBottom: 16 }}>
            LiveKit not reachable — showing sessions only, room state unknown.
          </p>
        )}

        <hr className="rule" />

        <div style={{ padding: "28px 0" }}>
          <span className="label" style={{ display: "block", marginBottom: 16 }}>
            Rooms ({rows.length})
          </span>

          {rows.length === 0 ? (
            <p className="body-sm italic">
              {loaded ? "No sessions or rooms" : "Loading…"}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {rows.map((r) => {
                const status = ROOM_STATUS[r.status];
                const translations = r.session?.translations ?? [];
                const participants = r.room?.participants ?? [];
                return (
                  <div
                    key={r.id}
                    className="transcript-card"
                    style={{ maxHeight: "none" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 12,
                        marginBottom: 12,
                      }}
                    >
                      <div>
                        <p
                          className="mono"
                          style={{
                            color: "var(--fg)",
                            marginBottom: 4,
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            flexWrap: "wrap",
                          }}
                        >
                          {r.id}
                          <span className={status.className}>
                            <span className="status-dot" />
                            {status.label}
                          </span>
                        </p>
                        <p className="body-sm">
                          {r.session
                            ? `${r.session.organizerIdentity} · created ${new Date(
                                r.session.createdAt
                              ).toLocaleTimeString()}`
                            : r.room
                              ? `created ${new Date(
                                  r.room.creationTime * 1000
                                ).toLocaleTimeString()}`
                              : ""}
                          {r.room
                            ? ` · ${r.room.numParticipants} participant${
                                r.room.numParticipants === 1 ? "" : "s"
                              }`
                            : r.session && overview?.livekit
                              ? " · no LiveKit room yet"
                              : ""}
                        </p>
                      </div>
                      {r.session ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => endSession(r.id)}
                        >
                          End session
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => deleteRoom(r.id)}
                        >
                          Delete room
                        </button>
                      )}
                    </div>

                    {r.session &&
                      (translations.length === 0 ? (
                        <p className="body-sm italic">No translation bridges</p>
                      ) : (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            marginBottom: participants.length ? 12 : 0,
                          }}
                        >
                          {translations.map((t) => (
                            <div
                              key={t.language}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 12,
                                flexWrap: "wrap",
                                padding: "8px 0",
                                borderTop: "1px solid var(--border-light)",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 12,
                                }}
                              >
                                <span
                                  className="mono"
                                  style={{ color: "var(--fg)" }}
                                >
                                  {t.language.toUpperCase()}
                                </span>
                                <span className={statusClass(t.status)}>
                                  <span className="status-dot" />
                                  {t.status}
                                </span>
                                <span className="body-sm">
                                  {t.subscriberCount} listener
                                  {t.subscriberCount === 1 ? "" : "s"}
                                </span>
                                <span className="mono" style={{ fontSize: 12 }}>
                                  {t.translatorIdentity}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="btn-ghost"
                                onClick={() => killBridge(r.id, t.language)}
                              >
                                Kill
                              </button>
                            </div>
                          ))}
                        </div>
                      ))}

                    {participants.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {participants.map((p) => (
                          <span
                            key={p.identity}
                            className="mono"
                            style={{
                              fontSize: 12,
                              padding: "3px 8px",
                              border: "1px solid var(--border)",
                              color: p.isTranslator
                                ? "var(--accent)"
                                : p.isOrganizer
                                  ? "var(--success)"
                                  : undefined,
                            }}
                          >
                            {p.identity}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

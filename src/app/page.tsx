"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BridgeStatus } from "@/lib/translation-bridge";
import type { Overview } from "@/lib/session-sync";

interface TranslationRow {
  language: string;
  status: BridgeStatus;
  subscriberCount: number;
  textTargets: string[];
}

interface SessionRow {
  sessionId: string;
  organizerIdentity: string;
  createdAt: string;
  translations: TranslationRow[];
}

type RoomState = "live" | "wait" | "unknown";

interface RoomView {
  session: SessionRow;
  state: RoomState;
  listeners: number | null;
}

const REFRESH_MS = 3000;
const WAVE_BARS = 14;

const STATE_LABEL: Record<RoomState, string> = {
  live: "On air",
  wait: "Waiting",
  unknown: "Unknown",
};

const STATE_HINT: Record<RoomState, string> = {
  live: "Organizer is connected",
  wait: "Waiting for the organizer to connect",
  unknown: "LiveKit not reachable, so state is unknown",
};

function formatAge(createdAt: string, now: number): string {
  const mins = Math.max(
    0,
    Math.floor((now - new Date(createdAt).getTime()) / 60000)
  );
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function organizerName(identity: string): string {
  return identity.replace(/^organizer-/, "");
}

/** Small deterministic PRNG so a room keeps the same thumbnail between refreshes. */
function seeded(id: string): () => number {
  let a = 0;
  for (let i = 0; i < id.length; i++) a = (a * 31 + id.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function thumbShape(id: string) {
  const rand = seeded(id);
  // Hue stays in the blue-to-teal-to-violet range of the app's accent
  const hue = 195 + Math.floor(rand() * 75);
  const bars = Array.from({ length: WAVE_BARS }, () => ({
    height: 14 + Math.round(rand() * 70),
    delay: Math.round(rand() * 14) / 10,
  }));
  return { hue, bars };
}

function buildViews(overview: Overview | null): RoomView[] {
  if (!overview) return [];
  // Orphaned rooms (no session) are an admin concern, not something to join
  const views = overview.rooms.flatMap<RoomView>((row) => {
    if (!row.session) return [];
    const session: SessionRow = { sessionId: row.id, ...row.session };
    if (!overview.livekit) {
      return [{ session, state: "unknown", listeners: null }];
    }
    const people = row.room?.participants ?? [];
    return [
      {
        session,
        state: row.status === "live" ? "live" : "wait",
        listeners: people.filter((p) => !p.isOrganizer && !p.isTranslator)
          .length,
      },
    ];
  });
  // On air first, then newest
  return views.sort((a, b) => {
    if ((a.state === "live") !== (b.state === "live")) {
      return a.state === "live" ? -1 : 1;
    }
    return (
      new Date(b.session.createdAt).getTime() -
      new Date(a.session.createdAt).getTime()
    );
  });
}

/* —— Icons: one 16px grid, 1.5 stroke —— */

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" strokeWidth="1.75" />
  </Icon>
);

const MicIcon = () => (
  <Icon>
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
    <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2" />
  </Icon>
);

const HeadphonesIcon = () => (
  <Icon>
    <path d="M2.5 9.5V8a5.5 5.5 0 0 1 11 0v1.5" />
    <rect x="2" y="9" width="3" height="4.5" rx="1.25" />
    <rect x="11" y="9" width="3" height="4.5" rx="1.25" />
  </Icon>
);

const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
    <path d="M10.5 3.75A1.75 1.75 0 0 0 8.75 2h-4A1.75 1.75 0 0 0 3 3.75v4A1.75 1.75 0 0 0 4.75 9.5" />
  </Icon>
);

const CheckIcon = () => (
  <Icon>
    <path d="m3.5 8.5 3 3 6-6.5" strokeWidth="1.75" />
  </Icon>
);

const AlertIcon = () => (
  <Icon>
    <path d="M8 2 1.75 13h12.5L8 2Z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Icon>
);

/* —— Pieces —— */

function NewSessionButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      className="dash-btn"
      onClick={onClick}
      disabled={loading}
      id="create-session-btn"
    >
      {loading ? (
        <>
          <span className="spinner" /> Creating…
        </>
      ) : (
        <>
          <PlusIcon /> New session
        </>
      )}
    </button>
  );
}

function CopyLinkButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/session/${sessionId}/watch`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Attendee link", url);
    }
  }

  return (
    <button
      type="button"
      className={`room-act${copied ? " room-act--done" : ""}`}
      onClick={copy}
      aria-label={`Copy attendee link for room ${sessionId}`}
      title="Copy attendee link"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied && <span aria-live="polite">Copied</span>}
    </button>
  );
}

function LanguageTags({ translations }: { translations: TranslationRow[] }) {
  if (translations.length === 0) {
    return <span className="room-none">No language yet</span>;
  }
  return (
    <>
      {translations.map((t) => (
        <Fragment key={t.language}>
          <span
            className="lang-tag"
            title={`${t.language.toUpperCase()} voice: ${t.status}, ${t.subscriberCount} subscribed`}
          >
            <span className={`status-dot is-${t.status}`} aria-hidden />
            {t.language.toUpperCase()}
            <span className="sr-only"> voice, {t.status}</span>
          </span>
          {t.textTargets
            .filter((lang) => lang !== t.language)
            .map((lang) => (
              <span
                key={lang}
                className="lang-tag lang-tag--text"
                title={`${lang.toUpperCase()} as text`}
              >
                {lang.toUpperCase()}
                <span className="sr-only"> text</span>
              </span>
            ))}
        </Fragment>
      ))}
    </>
  );
}

function JoinDialog({
  sessionId,
  joining,
  onCancel,
  onConfirm,
}: {
  sessionId: string;
  joining: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="join-dialog"
      aria-labelledby="join-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!joining) onCancel();
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) dismisses
        if (e.target === ref.current && !joining) onCancel();
      }}
    >
      <h2 id="join-dialog-title" className="display display-md">
        Join room <span className="join-dialog-id">{sessionId}</span>?
      </h2>
      <p className="body">
        Opens live subtitles and joins the session as a listener.
      </p>
      <div className="join-dialog-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={onCancel}
          disabled={joining}
        >
          Cancel
        </button>
        <button
          type="button"
          className="dash-btn"
          onClick={onConfirm}
          disabled={joining}
          autoFocus
        >
          {joining ? (
            <>
              <span className="spinner" /> Joining…
            </>
          ) : (
            "Join session"
          )}
        </button>
      </div>
    </dialog>
  );
}

function RoomTile({
  view,
  now,
  onJoin,
}: {
  view: RoomView;
  now: number;
  onJoin: (sessionId: string) => void;
}) {
  const { session, state, listeners } = view;
  const { hue, bars } = thumbShape(session.sessionId);
  const started = new Date(session.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <li className={`room${state === "live" ? " room--live" : ""}`}>
      <button
        type="button"
        className="room-thumb"
        style={{ "--h": hue } as React.CSSProperties}
        onClick={() => onJoin(session.sessionId)}
        aria-label={`Join room ${session.sessionId}`}
        aria-haspopup="dialog"
        title="Join"
      >
        <span className="room-wave" aria-hidden>
          {bars.map((b, i) => (
            <i
              key={i}
              style={
                {
                  "--bar": `${b.height}%`,
                  "--d": `-${b.delay}s`,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
        <span
          className={`room-badge room-badge--${state}`}
          title={STATE_HINT[state]}
        >
          <span
            className={`live-dot${state === "live" ? " live-dot--on" : ""}`}
            aria-hidden
          />
          {STATE_LABEL[state]}
        </span>
      </button>

      <div className="room-body">
        <div className="room-row">
          <span className="room-id">{session.sessionId}</span>
          <span
            className="room-age"
            title={`${organizerName(session.organizerIdentity)} · started ${started}`}
          >
            {formatAge(session.createdAt, now)}
          </span>
        </div>

        <div className="room-langs">
          <LanguageTags translations={session.translations} />
        </div>

        <div className="room-foot">
          <span
            className={`room-listeners${listeners ? "" : " room-listeners--zero"}`}
            title="Listeners connected"
          >
            <HeadphonesIcon />
            {listeners ?? "—"}
            <span className="sr-only">
              {listeners === 1 ? " listener" : " listeners"}
            </span>
          </span>

          <div className="room-actions">
            <Link
              href={`/session/${session.sessionId}/broadcast`}
              className="room-act"
              aria-label={`Broadcast room ${session.sessionId}`}
              title="Broadcast"
            >
              <MicIcon />
            </Link>
            <CopyLinkButton sessionId={session.sessionId} />
          </div>
        </div>
      </div>
    </li>
  );
}

export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      // The server reconciles sessions with LiveKit rooms; if LiveKit is
      // down it still answers with sessions only (overview.livekit = false)
      const res = await fetch("/api/overview");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setOverview(data as Overview);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
    setNow(Date.now());
    setLoaded(true);
  }, []);

  useEffect(() => {
    // Defer the first fetch out of the effect body (setState-in-effect rule)
    const initial = setTimeout(refresh, 0);
    const interval = setInterval(refresh, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  async function createSession() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizerName: "host" }),
      });
      const data = await res.json();
      if (!res.ok || !data.sessionId) {
        throw new Error(data.error || "Failed to create session");
      }
      router.push(`/session/${data.sessionId}/broadcast`);
    } catch (err) {
      console.error("Failed to create session:", err);
      setCreateError((err as Error).message);
      setCreating(false);
    }
  }

  const views = buildViews(overview);
  const livekitUp = overview?.livekit === true;
  const onAir = views.filter((v) => v.state === "live").length;
  const listeners = views.reduce((sum, v) => sum + (v.listeners ?? 0), 0);

  return (
    <div className="dash">
      <header className="dash-bar">
        <span className="dash-brand">
          <em>Live</em> Translate
        </span>
        <NewSessionButton onClick={createSession} loading={creating} />
      </header>

      <main className="dash-main">
        <div className="dash-head enter">
          <h1 className="display display-md">Live rooms</h1>
          {livekitUp && views.length > 0 && (
            <p className="dash-summary" aria-live="polite">
              <span>{onAir} on air</span>
              <span className="dash-summary-sep" aria-hidden>
                /
              </span>
              <span>
                {listeners} listener{listeners === 1 ? "" : "s"}
              </span>
            </p>
          )}
        </div>

        {createError && (
          <p className="dash-note dash-note--error" role="alert">
            <AlertIcon />
            <span>Couldn’t create a session: {createError}</span>
          </p>
        )}

        {loadError && (
          <p className="dash-note dash-note--error" role="alert">
            <AlertIcon />
            <span>
              Couldn’t load rooms: {loadError}
              {views.length > 0 && " (showing last list)"}
            </span>
          </p>
        )}

        {loaded && overview && !livekitUp && !loadError && (
          <p className="dash-note" role="status">
            <AlertIcon />
            <span>LiveKit not reachable. On-air state and listeners unavailable.</span>
          </p>
        )}

        {!loaded ? (
          <p className="dash-loading" role="status">
            <span className="spinner" /> Loading rooms…
          </p>
        ) : views.length === 0 ? (
          overview && (
            <div className="dash-empty enter">
              <h2 className="display display-md">No rooms running</h2>
              <p className="body">
                Start a session, speak, and share the QR code.
              </p>
              <NewSessionButton onClick={createSession} loading={creating} />
            </div>
          )
        ) : (
          <ul className="rooms enter-d1">
            {views.map((view) => (
              <RoomTile
                key={view.session.sessionId}
                view={view}
                now={now}
                onJoin={setPendingJoin}
              />
            ))}
          </ul>
        )}

        {pendingJoin && (
          <JoinDialog
            sessionId={pendingJoin}
            joining={joining}
            onCancel={() => setPendingJoin(null)}
            onConfirm={() => {
              setJoining(true);
              // join=1 lets the watch page skip its own "Join session" step.
              // Client-side navigation keeps this click as the user gesture
              // that lets translated audio play.
              router.push(`/session/${pendingJoin}/watch?join=1`);
            }}
          />
        )}

        <p className="dash-foot">
          Powered by Gemini Live API + LiveKit ·{" "}
          <Link href="/admin">Admin</Link>
        </p>
      </main>
    </div>
  );
}

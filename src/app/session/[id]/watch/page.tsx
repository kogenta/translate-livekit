"use client";

import { useEffect, useState, useCallback, useMemo, use, type CSSProperties } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track, RoomEvent } from "livekit-client";
import SplitTranscript, { buildRows, type LanguagePair } from "./components/SplitTranscript";
import AudioSelector, { type AudioChoice } from "./components/AudioSelector";
import TranscriptDownload from "./components/TranscriptDownload";
import { CollapseIcon, ExpandIcon, MoonIcon, SunIcon } from "./components/icons";
import { useTranscripts } from "./hooks/useTranscripts";
import { useTranslationBridges } from "./hooks/useTranslationBridges";
import { DEFAULT_PAIR, getLanguageByCode } from "@/lib/languages";

type Theme = "light" | "dark";

const PAIR_KEY = "watch-pair";
const THEME_KEY = "watch-theme";
const FONT_SCALE_KEY = "watch-font-scale";
const HIDDEN_KEY = "watch-hidden";

// Subtitle size multiplier, on top of the responsive base size
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 2.5;
const FONT_SCALE_STEP = 0.1;

// Storage can throw (private mode, blocked site data) — always fall back
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-essential preference — ignore
  }
}

function loadPair(): LanguagePair {
  const [left, right] = (readStorage(PAIR_KEY) ?? "").split(",");
  if (getLanguageByCode(left) && getLanguageByCode(right) && left !== right) {
    return [left, right];
  }
  return DEFAULT_PAIR;
}

/** LiveKit identity of the bot that speaks `code` (see TranslationBridge). */
function translatorIdentityFor(code: string): string {
  return `translator-${code}`;
}

function loadFontScale(): number {
  const saved = Number(readStorage(FONT_SCALE_KEY));
  return saved >= FONT_SCALE_MIN && saved <= FONT_SCALE_MAX ? saved : 1;
}

/** Whether a key press belongs to a control rather than a page shortcut. */
function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(target.tagName))
  );
}

function loadTheme(): Theme {
  const saved = readStorage(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function AttendeeView({ sessionId }: { sessionId: string }) {
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const [pair, setPair] = useState<LanguagePair>(loadPair);
  const [audio, setAudio] = useState<AudioChoice>("off");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [large, setLarge] = useState(false);
  const [fontScale, setFontScale] = useState(loadFontScale);
  const [hiddenLang, setHiddenLang] = useState<string | null>(() =>
    readStorage(HIDDEN_KEY)
  );

  const languages = useMemo(() => [...pair], [pair]);
  const { bridges, retry, retryFailed } = useTranslationBridges(sessionId, languages);
  const { groups, formatTime, getTranscript } = useTranscripts(room, languages);

  // Both columns go into the file, even if one is hidden on screen
  const getExport = useCallback(() => {
    const { groups: all, startedAt } = getTranscript();
    return { sessionId, pair, startedAt, rows: buildRows(all, pair, formatTime) };
  }, [getTranscript, sessionId, pair, formatTime]);

  const isConnected = remoteParticipants.some((p) =>
    p.identity.startsWith("organizer-")
  );

  // Languages with a translated voice in the room right now. Read from the
  // translator bots present rather than the subscribe response: in hybrid
  // mode the organizer can move the one voice to the other side mid-session
  // (the bot for the new language joins, the old one leaves).
  const audioLanguages = languages.filter(
    (code) =>
      bridges[code]?.status === "active" &&
      remoteParticipants.some((p) => p.identity === translatorIdentityFor(code))
  );

  // A pair change (or a text-only side) can drop the language being listened
  // to; the choice is kept, so it resumes if that voice comes back
  const effectiveAudio =
    audio === "off" || audio === "original" || audioLanguages.includes(audio)
      ? audio
      : "off";

  const handlePairChange = useCallback((next: LanguagePair) => {
    setPair(next);
    writeStorage(PAIR_KEY, next.join(","));
  }, []);

  // A hidden language that's no longer in the pair hides nothing
  const effectiveHidden = hiddenLang && pair.includes(hiddenLang) ? hiddenLang : null;

  const handleHiddenChange = useCallback((lang: string | null) => {
    setHiddenLang(lang);
    writeStorage(HIDDEN_KEY, lang ?? "");
  }, []);

  const changeFontScale = useCallback((delta: number) => {
    setFontScale((s) => {
      const next =
        Math.round(
          Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, s + delta)) * 10
        ) / 10;
      writeStorage(FONT_SCALE_KEY, String(next));
      return next;
    });
  }, []);

  // Keyboard: +/- resize the subtitles
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isInteractive(e.target)) return;
      if (e.key === "+" || e.key === "=") {
        changeFontScale(FONT_SCALE_STEP);
      } else if (e.key === "-" || e.key === "_") {
        changeFontScale(-FONT_SCALE_STEP);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [changeFontScale]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      writeStorage(THEME_KEY, next);
      return next;
    });
  }, []);

  // Bridge requests 404 until the organizer's room exists — retry on join
  useEffect(() => {
    if (isConnected) retryFailed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on organizer (re)join
  }, [isConnected]);

  // Subscribe to exactly one audio track (autoSubscribe is off, so nothing
  // plays unless chosen here). Re-run as participants publish.
  const translatorIdentity = audioLanguages.includes(effectiveAudio)
    ? translatorIdentityFor(effectiveAudio)
    : null;

  useEffect(() => {
    if (!room) return;

    const updateSubscriptions = () => {
      for (const [, participant] of room.remoteParticipants) {
        const wanted =
          effectiveAudio === "original"
            ? participant.identity.startsWith("organizer-")
            : participant.identity === translatorIdentity;
        for (const [, pub] of participant.trackPublications) {
          if (pub.kind === Track.Kind.Audio && pub.isSubscribed !== wanted) {
            pub.setSubscribed(wanted);
          }
        }
      }
    };

    updateSubscriptions();
    room.on(RoomEvent.TrackPublished, updateSubscriptions);
    room.on(RoomEvent.ParticipantConnected, updateSubscriptions);
    return () => {
      room.off(RoomEvent.TrackPublished, updateSubscriptions);
      room.off(RoomEvent.ParticipantConnected, updateSubscriptions);
    };
  }, [room, effectiveAudio, translatorIdentity]);

  // Keep large mode in sync if the user exits fullscreen via Esc/browser UI
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setLarge(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleLarge = useCallback(() => {
    // Flip the layout immediately — the Fullscreen API is a best-effort
    // bonus and may be unsupported, or its functions may exist but throw
    // synchronously when called (Permissions Policy violations, sandboxed
    // iframes/webviews without allow="fullscreen"), so large mode must not
    // depend on it succeeding, and the call itself needs a try/catch —
    // an existence check alone doesn't protect against a synchronous throw.
    setLarge(!large);
    try {
      if (large) document.exitFullscreen?.()?.catch(() => {});
      else document.documentElement.requestFullscreen?.()?.catch(() => {});
    } catch {
      // Fullscreen API unavailable/blocked in this context — ignore
    }
  }, [large]);

  const names = pair.map((code) => getLanguageByCode(code)?.name ?? code);
  const placeholder = isConnected
    ? `Listening — speak in ${names[0]} or ${names[1]}`
    : "Waiting for the broadcast to start";

  return (
    <div
      className={`watch${large ? " watch--large" : ""}`}
      data-theme={theme}
      style={{ "--font-scale": fontScale } as CSSProperties}
    >
      <header className="watch-bar">
        <div className="watch-bar-left">
          <span className={`live-dot${isConnected ? " live-dot--on" : ""}`} />
          <span className="watch-bar-title">{isConnected ? "Live" : "Waiting"}</span>
          <span className="watch-bar-session">{sessionId}</span>
        </div>
        <div className="watch-bar-right">
          <AudioSelector value={effectiveAudio} languages={audioLanguages} onChange={setAudio} />
          <div className="font-size" role="group" aria-label="Subtitle size">
            <button
              type="button"
              className="icon-btn font-size-btn"
              onClick={() => changeFontScale(-FONT_SCALE_STEP)}
              disabled={fontScale <= FONT_SCALE_MIN}
              aria-label="Smaller subtitles"
              title="Smaller subtitles (−)"
            >
              A<sup>−</sup>
            </button>
            <span className="font-size-value" aria-live="polite">
              {Math.round(fontScale * 100)}%
            </span>
            <button
              type="button"
              className="icon-btn font-size-btn font-size-btn--up"
              onClick={() => changeFontScale(FONT_SCALE_STEP)}
              disabled={fontScale >= FONT_SCALE_MAX}
              aria-label="Larger subtitles"
              title="Larger subtitles (+)"
            >
              A<sup>+</sup>
            </button>
          </div>
          <TranscriptDownload getExport={getExport} disabled={groups.length === 0} />
          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Light theme" : "Dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={toggleLarge}
            aria-label={large ? "Exit fullscreen" : "Fullscreen"}
            title={large ? "Exit fullscreen" : "Fullscreen"}
          >
            {large ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        </div>
      </header>

      <SplitTranscript
        groups={groups}
        formatTime={formatTime}
        pair={pair}
        onPairChange={handlePairChange}
        hiddenLang={effectiveHidden}
        onHiddenLangChange={handleHiddenChange}
        bridges={bridges}
        audioLanguages={audioLanguages}
        onRetry={retry}
        placeholder={placeholder}
      />
    </div>
  );
}

export default function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ join?: string }>;
}) {
  const { id: sessionId } = use(params);
  // ?join=1: the attendee already confirmed on the dashboard, so skip the
  // "Join session" step below
  const autoJoin = use(searchParams).join === "1";
  const [token, setToken] = useState("");
  const [livekitUrl, setLivekitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(autoJoin);

  useEffect(() => {
    async function fetchToken() {
      try {
        const identity = `attendee-${Math.random().toString(36).slice(2, 8)}`;
        const res = await fetch(
          `/api/token?room=${sessionId}&identity=${identity}&role=attendee`
        );
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setToken(data.token);
        setLivekitUrl(data.serverUrl);
      } catch (err) {
        setError((err as Error).message);
      }
    }
    fetchToken();
  }, [sessionId]);

  if (error) {
    return (
      <div className="page">
        <div className="container" style={{ textAlign: "center" }}>
          <p className="display display-md" style={{ marginBottom: 16 }}>
            Something went wrong
          </p>
          <p className="body-sm" style={{ marginBottom: 32 }}>{error}</p>
          <button
            className="btn btn-outline"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!token || !livekitUrl) {
    return (
      <div className="page">
        <div className="spinner" />
      </div>
    );
  }

  // Joining needs a user gesture so translated audio is allowed to play
  if (!started) {
    return (
      <div className="page">
        <div className="container enter" style={{ textAlign: "center" }}>
          <h1 className="display display-lg" style={{ marginBottom: 12 }}>
            Live <em>Interpreter</em>
          </h1>
          <p className="body-sm" style={{ marginBottom: 36 }}>
            ไทย ⇄ English · real-time subtitles
          </p>
          <button className="btn btn-dark" onClick={() => setStarted(true)}>
            Join session
          </button>
          <p className="mono" style={{ marginTop: 28, fontSize: 12 }}>
            {sessionId}
          </p>
        </div>
      </div>
    );
  }

  return (
    <LiveKitRoom
      video={false}
      audio={false}
      token={token}
      serverUrl={livekitUrl}
      connectOptions={{ autoSubscribe: false }}
      style={{ width: "100%" }}
    >
      <RoomAudioRenderer />
      <AttendeeView sessionId={sessionId} />
    </LiveKitRoom>
  );
}

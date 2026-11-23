"use client";

import { useEffect, useState, useCallback, useMemo, use, useRef } from "react";
import {
  LiveKitRoom,
  useLocalParticipant,
  useRoomContext,
  useRemoteParticipants,
  TrackToggle,
  useTracks,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track, type AudioCaptureOptions } from "livekit-client";
import SessionQRCode from "@/components/SessionQRCode";
import { getLanguageByCode } from "@/lib/languages";

const NOISE_FILTER_KEY = "broadcast-noise-filter";

// Jabra Speak2 (and other USB conference speakerphones) run their own
// hardware DSP for echo cancellation/noise suppression/gain — stacking the
// browser's software versions on top double-processes the signal and tends
// to muffle speech, which then hurts Gemini's transcription/translation
// accuracy. So browser noise suppression is opt-in, for laptop/built-in mics
// in noisy rooms. (Every bridge also runs a server-side high-pass + noise
// gate — see src/lib/audio-filter.ts — regardless of this setting.)
function captureOptions(noiseFilter: boolean): AudioCaptureOptions {
  return {
    echoCancellation: false,
    noiseSuppression: noiseFilter,
    voiceIsolation: noiseFilter,
    autoGainControl: false,
    channelCount: 1,
  };
}

function loadNoiseFilter(): boolean {
  try {
    return localStorage.getItem(NOISE_FILTER_KEY) === "on";
  } catch {
    return false;
  }
}

interface TranslationInfo {
  language: string;
  translatorIdentity: string;
  status: string;
  subscriberCount: number;
  textTargets?: string[];
}

interface AudioConfig {
  mode: "hybrid" | "dual";
  pair: string[];
  audioLanguage: string;
}

function BroadcastControls({
  sessionId,
  initialNoiseFilter,
}: {
  sessionId: string;
  initialNoiseFilter: boolean;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [translations, setTranslations] = useState<TranslationInfo[]>([]);
  const [audioConfig, setAudioConfig] = useState<AudioConfig | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [noiseFilter, setNoiseFilter] = useState(initialNoiseFilter);
  const [noiseFilterBusy, setNoiseFilterBusy] = useState(false);
  const audioTracks = useTracks([Track.Source.Microphone]);
  const remoteParticipants = useRemoteParticipants();
  const isMicOn = audioTracks.some(
    (t) => t.participant.identity === localParticipant.identity
  );

  // Count only real attendees, not translator bots
  const listenerCount = remoteParticipants.filter(
    (p) => !p.identity.startsWith("translator-")
  ).length;

  const joinUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/session/${sessionId}/watch`
      : "";

  // Poll the server's view of this session's bridges. State is only set
  // once the response is in — never synchronously from the effect below —
  // and not at all after unmount.
  const mountedRef = useRef(true);
  const fetchTranslations = useCallback(
    () =>
      fetch(`/api/translate/status?sessionId=${sessionId}`)
        .then((res) => res.json())
        .then((data) => {
          if (!mountedRef.current) return;
          setTranslations(data.translations || []);
          if (data.audio) setAudioConfig(data.audio);
        })
        .catch((err) => console.error("Failed to fetch translations:", err)),
    [sessionId]
  );

  // Hybrid mode runs one Live session per room, so only one side of the
  // pair gets a translated voice — the organizer picks which. Switching
  // starts the new voice before stopping the old one (a few seconds).
  const switchVoice = useCallback(
    async (language: string) => {
      setVoiceBusy(true);
      setVoiceError(null);
      try {
        const res = await fetch(`/api/sessions/${sessionId}/audio-language`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to switch voice");
        setAudioConfig(data.audio);
        fetchTranslations();
      } catch (err) {
        setVoiceError((err as Error).message);
      } finally {
        setVoiceBusy(false);
      }
    },
    [sessionId, fetchTranslations]
  );

  useEffect(() => {
    mountedRef.current = true;
    void fetchTranslations();
    const interval = setInterval(fetchTranslations, 3000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchTranslations]);


  // Re-acquire the live mic with new processing constraints. (Changing the
  // LiveKitRoom `options` prop instead would rebuild the whole Room.)
  const toggleNoiseFilter = useCallback(async () => {
    const next = !noiseFilter;
    setNoiseFilter(next);
    try {
      localStorage.setItem(NOISE_FILTER_KEY, next ? "on" : "off");
    } catch {
      // Non-essential preference — ignore
    }
    const track = localParticipant.getTrackPublication(
      Track.Source.Microphone
    )?.audioTrack;
    if (!track) return; // applied when the mic is next enabled
    setNoiseFilterBusy(true);
    try {
      const deviceId = track.mediaStreamTrack.getSettings().deviceId;
      await track.restartTrack({ ...captureOptions(next), deviceId });
    } catch (err) {
      console.error("Failed to apply noise filter:", err);
      setNoiseFilter(!next);
    } finally {
      setNoiseFilterBusy(false);
    }
  }, [noiseFilter, localParticipant]);

  return (
    <div className="container enter">
      {/* Header */}
      <div style={{ marginBottom: 48 }}>
        <h1 className="display display-lg" style={{ marginBottom: 8 }}>
          Broadcasting
        </h1>
        <p className="mono">{sessionId}</p>
      </div>

      {/* Mic status */}
      <div style={{ marginBottom: 40 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className={`waveform ${isMicOn ? "active" : "idle"}`}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="waveform-bar" />
              ))}
            </div>
            <span
              className="status"
              style={{ color: isMicOn ? "var(--success)" : "var(--fg-ghost)" }}
            >
              <span className={`status-dot ${isMicOn ? "pulse" : ""}`} />
              {isMicOn ? "Live" : "Muted"}
            </span>
          </div>

          <span className="mono">
            {listenerCount} listener{listenerCount !== 1 ? "s" : ""}
          </span>
        </div>

        <TrackToggle
          source={Track.Source.Microphone}
          style={{
            width: "100%",
            padding: "14px 32px",
            fontFamily: "var(--font-body)",
            fontSize: "14px",
            fontWeight: 500,
            border: isMicOn ? "1px solid var(--error)" : "none",
            borderRadius: 0,
            background: isMicOn ? "transparent" : "var(--fg)",
            color: isMicOn ? "var(--error)" : "var(--bg)",
            cursor: "pointer",
          }}
        />

        <div className="toggle-row">
          <div>
            <p className="toggle-title">Noise filter</p>
            <p className="body-sm">
              Browser noise suppression for laptop mics. Leave off for
              speakerphones with built-in DSP.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={noiseFilter}
            aria-label="Noise filter"
            className={`switch${noiseFilter ? " on" : ""}`}
            onClick={toggleNoiseFilter}
            disabled={noiseFilterBusy}
          />
        </div>

        {audioConfig?.mode === "hybrid" && (
          <div className="toggle-row">
            <div>
              <p className="toggle-title">Translated voice</p>
              <p className="body-sm">
                {voiceError ??
                  (voiceBusy
                    ? "Switching…"
                    : "Spoken translation in one language; the other side gets subtitles.")}
              </p>
            </div>
            <div className="seg" role="radiogroup" aria-label="Translated voice">
              {audioConfig.pair.map((code) => (
                <button
                  key={code}
                  type="button"
                  role="radio"
                  aria-checked={audioConfig.audioLanguage === code}
                  title={getLanguageByCode(code)?.name ?? code}
                  className={`seg-btn${audioConfig.audioLanguage === code ? " active" : ""}`}
                  onClick={() => switchVoice(code)}
                  disabled={voiceBusy}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <hr className="rule" />

      {/* QR code */}
      <div
        style={{
          padding: "32px 0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <span className="label">Share with attendees</span>
        <SessionQRCode url={joinUrl} size={140} />
        <p className="mono" style={{ wordBreak: "break-all", textAlign: "center" }}>
          {joinUrl}
        </p>
      </div>

      <hr className="rule" />

      {/* Active translations */}
      <div style={{ padding: "28px 0" }}>
        <span className="label" style={{ marginBottom: 16, display: "block" }}>
          Translations · {translations.length}
        </span>

        {translations.length === 0 ? (
          <p className="body-sm italic">
            None yet — attendees can request them
          </p>
        ) : (
          translations.map((t) => {
            const lang = getLanguageByCode(t.language);
            return (
              <div key={t.language} className="lang-row">
                <div className="lang-row-left">
                  <span className="lang-flag">{lang?.flag || "🌐"}</span>
                  <span className="lang-name">
                    {lang?.name || t.language.toUpperCase()}
                  </span>
                  {!!t.textTargets?.length && (
                    <span className="lang-meta">
                      + {t.textTargets.map((c) => c.toUpperCase()).join(", ")} text
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="lang-meta">
                    {t.subscriberCount} listener{t.subscriberCount !== 1 ? "s" : ""}
                  </span>
                  <span className={`status status--${t.status === "active" ? "active" : "waiting"}`}>
                    <span className="status-dot pulse" />
                    {t.status}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <hr className="rule" />

      {/* End */}
      <div style={{ paddingTop: 28 }}>
        <button
          className="btn-danger"
          onClick={async () => {
            // Tear down every translation bridge (and its Gemini session)
            // now, rather than waiting for each attendee tab to leave.
            await fetch(`/api/sessions/${sessionId}`, {
              method: "DELETE",
              keepalive: true,
            }).catch(() => {});
            room.disconnect();
            window.location.href = "/";
          }}
          style={{ width: "100%" }}
        >
          End broadcast
        </button>
      </div>
    </div>
  );
}

export default function BroadcastPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: sessionId } = use(params);
  const [token, setToken] = useState("");
  const [livekitUrl, setLivekitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Read once: LiveKitRoom rebuilds the Room whenever `options` changes, so
  // later toggles go through restartTrack in BroadcastControls instead.
  const [initialNoiseFilter] = useState(() =>
    typeof window === "undefined" ? false : loadNoiseFilter()
  );
  const roomOptions = useMemo(
    () => ({ audioCaptureDefaults: captureOptions(initialNoiseFilter) }),
    [initialNoiseFilter]
  );

  useEffect(() => {
    async function fetchToken() {
      try {
        const identity = `organizer-host`;
        const res = await fetch(
          `/api/token?room=${sessionId}&identity=${identity}&role=organizer`
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
          <button className="btn btn-outline" onClick={() => (window.location.href = "/")}>
            Go home
          </button>
        </div>
      </div>
    );
  }

  if (!token || !livekitUrl) {
    return (
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="page page-top">
      <LiveKitRoom
        video={false}
        audio={true}
        options={roomOptions}
        token={token}
        serverUrl={livekitUrl}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
        }}
        onDisconnected={() => {
          setError("Disconnected from LiveKit room. Please check your credentials or network connection.");
        }}
      >

        <BroadcastControls
          sessionId={sessionId}
          initialNoiseFilter={initialNoiseFilter}
        />
      </LiveKitRoom>
    </div>
  );
}

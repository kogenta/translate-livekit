/**
 * TranslationBridge: Connects a LiveKit room to a Gemini Live API WebSocket
 * for real-time audio translation.
 *
 * Each bridge instance:
 * 1. Joins the LiveKit room as a bot participant (e.g., "translator-en")
 * 2. Subscribes to the organizer's audio track
 * 3. Noise-filters the PCM frames and pipes them to Gemini Live via WebSocket
 * 4. Receives translated audio back and publishes it as a new track
 * 5. Publishes both the source transcript and the translation on the data
 *    channel, so a client can pair them per utterance
 *
 * Two-way conversation (e.g. TH ⇄ EN) runs one bridge per direction: the
 * "en" bridge carries Thai speech, the "th" bridge carries English speech.
 * Every bridge transcribes everything it hears; the watch page keeps only
 * the utterances whose detected source language differs from the bridge's
 * target (see SplitTranscript), so each utterance is shown exactly once,
 * with its original and translation from the same Gemini session.
 */

import {
  Room,
  RoomEvent,
  LocalAudioTrack,
  AudioSource,
  AudioFrame,
  TrackPublishOptions,
  TrackSource,
  RemoteTrackPublication,
  RemoteParticipant,
  RemoteAudioTrack,
  TrackKind,
  AudioStream,
} from "@livekit/rtc-node";
import WebSocket from "ws";
import { NoiseFilter } from "./audio-filter";
import { liveDomainPrompt } from "./interpreter-prompt";
import {
  detectLanguage,
  getLanguageByCode,
  SUPPORTED_LANGUAGES,
} from "./languages";
import {
  endsSentence,
  findSentenceBreak,
  lastPunctuationEnd,
  lastSentenceEnd,
  MIN_SENTENCE_CHARS,
  switchesLanguage,
  untilLastSentenceEnd,
} from "./sentence-boundary";
import { formatTranscript } from "./text-format";
import {
  refineTranslation,
  restoreEnglishTerms,
  translateText,
  type ContextLine,
} from "./text-translator";
import type { TranscriptionKind, TranscriptionMessage } from "./transcription";

export type BridgeStatus = "starting" | "active" | "error" | "closed";

// The only source languages this deployment's organizers actually speak:
// SUPPORTED_LANGUAGES, the same list attendees can pick. Gemini's
// translation_config has no field to restrict/hint the source language
// (confirmed against the live BidiGenerateContent schema — only
// targetLanguageCode and echoTargetLanguage exist), so this list is enforced
// two ways instead: a systemInstruction bias sent with every session, and a
// script-based filter that drops transcript text that isn't plausibly one of
// these languages (catches stray Vietnamese/other false-positive detections).
const SOURCE_LANGUAGE_NAMES: readonly { code: string; name: string }[] =
  SUPPORTED_LANGUAGES.map(({ code, name }) => ({ code, name }));

// Unicode ranges/codepoints that can only appear in a language outside
// SUPPORTED_LANGUAGES. Vietnamese is the specific false-positive this guards
// against (it shares the Latin script with English, so a generic "is this
// Thai/Latin" check wouldn't catch it) — đ/ơ/ư and the precomposed
// Vietnamese tone-mark block (U+1EA0-U+1EF9) never occur in English text.
// Re-check this if a language that uses Cyrillic or Hangul is enabled.
const DISALLOWED_SCRIPT_PATTERN = /[ĐđƠơƯưẠ-ỹЀ-ӿ가-힣]/;

/** True if `text` contains characters that rule out every supported source. */
function hasDisallowedScript(text: string): boolean {
  return DISALLOWED_SCRIPT_PATTERN.test(text);
}

// A fresh segment's opening chunk sharing at least this many leading
// characters with the previous segment's full text is treated as Gemini
// restarting/re-stating a turn rather than genuinely new speech (see
// RESTART_DUPLICATE_MIN_OVERLAP usage in publishTranscriptionText). Thai has
// no spaces between words, so ~12 characters is a couple of words — enough
// to be a real restatement, short enough not to false-positive on two
// unrelated sentences that happen to open the same way.
const RESTART_DUPLICATE_MIN_OVERLAP = 12;

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

// Process-wide queue so only one bot is inside room.connect() at a time —
// the two-way watch page starts two bridges at once, and concurrent connects
// compete for the event loop during the native layer's short ack window (see
// connectRoomWithRetry). Kept on globalThis to survive dev-mode HMR.
const connectGlobals = globalThis as unknown as {
  __lkConnectQueue?: Promise<unknown>;
  __lkFailedRooms?: Room[];
};

/** Reject if `promise` has not settled after `ms` (it is not cancelled). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function serializeRoomConnect<T>(fn: () => Promise<T>): Promise<T> {
  const run = (connectGlobals.__lkConnectQueue ?? Promise.resolve()).then(
    fn,
    fn,
  );
  connectGlobals.__lkConnectQueue = run.catch(() => {});
  return run;
}

/**
 * Keep a Room whose connect failed reachable forever. If the native layer
 * already dropped its handles, letting the GC finalize their wrappers throws
 * "trying to drop an invalid handle" as an uncaught exception, which crashes
 * the server process. Each retained Room is inert (rtc-node detached its
 * event listener when connect threw) and small.
 */
function retainFailedRoom(room: Room): void {
  room.removeAllListeners();
  (connectGlobals.__lkFailedRooms ??= []).push(room);
}

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Sentence-by-sentence correction state of one Live segment (see the Polish
 * comment in TranslationBridge). `draft` and `original` follow the segment
 * while it is open and are frozen when it closes.
 */
interface LiveRefine {
  segmentId: number;
  draft: string;
  original: string;
  /** Corrected text for `draft.slice(0, done)`. */
  corrected: string;
  done: number;
  /**
   * A request is in flight; `again` asks for another run when it returns
   * (`againToEnd`: one that corrects everything, not just whole sentences).
   */
  busy: boolean;
  again: boolean;
  againToEnd: boolean;
  closed: boolean;
  /** What was last published for the row (skips repeats). */
  published: string;
}

function newLiveRefine(segmentId: number): LiveRefine {
  return {
    segmentId,
    draft: "",
    original: "",
    corrected: "",
    done: 0,
    busy: false,
    again: false,
    againToEnd: false,
    closed: false,
    published: "",
  };
}

/** Two pieces of subtitle text joined with a space. */
function joinText(a: string, b: string): string {
  return a && b ? `${a} ${b}` : a || b;
}

export class TranslationBridge {
  private room: Room | null = null;
  private geminiWs: WebSocket | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private publishedTrackSid: string = "";
  private transcriptionSegmentId: number = 0;
  // Part of every segment id: a later bridge for the same language (e.g.
  // after the organizer switches the voice language away and back) restarts
  // the counter, and must not append to segments clients already hold.
  private readonly segmentPrefix: string = `${Date.now().toString(36)}-`;
  private framesSentToGemini: number = 0;
  private framesReceivedFromGemini: number = 0;
  // Audio Gemini bills by duration, logged as [Usage] when the bridge stops
  private samplesSentToGemini: number = 0;
  private samplesReceivedFromGemini: number = 0;
  // Live sometimes speaks over speech it isn't translating, repeating scraps
  // of it ("kids") with no transcription. Audio plays only within this long of
  // a translation chunk. A translation's text came first in 50 of 50 clips (by
  // 12-1498 ms) and its audio ran at most 2.2 s past its latest chunk, including
  // 20 s of unbroken speech and a speaker change with no pause. Kept well above
  // that: too long only lets a scrap through, too short would cut a translation.
  private static readonly TRANSLATED_AUDIO_HOLD_MS = 4000;
  private lastTranslationChunkAt: number = 0;
  private samplesMuted: number = 0;

  public readonly targetLanguage: string;
  public readonly sessionId: string;
  public readonly identity: string;
  public status: BridgeStatus = "starting";
  public subscriberCount: number = 0;

  // Gemini Live API config
  private readonly geminiApiKey: string;
  private readonly geminiModel: string = "gemini-3.5-live-translate-preview";
  private readonly sampleRate: number = 24000; // Gemini outputs 24kHz
  // Gemini live-translate expects 16kHz PCM input; rtc-node's AudioStream
  // resamples the 48kHz LiveKit capture down to this rate
  private readonly inputSampleRate: number = 16000;
  private readonly channels: number = 1;
  private static readonly SETUP_TIMEOUT_MS = 15_000;
  private static readonly RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_ATTEMPTS = 6;
  private static readonly CONNECT_TIMEOUT_MS = 20_000;
  private static readonly DISCONNECT_TIMEOUT_MS = 5_000;

  // LiveKit config
  private readonly livekitUrl: string;
  private readonly livekitApiKey: string;
  private readonly livekitApiSecret: string;

  private geminiSetupComplete: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private organizerIdentity: string;
  private lastAudioFrameTime: number = 0;
  private captureChain: Promise<void> = Promise.resolve();

  // Environmental-noise filter applied to organizer audio before Gemini, and
  // the speech detector the silence saver below relies on. NOISE_FILTER=off
  // stops it altering audio (e.g. to A/B against a hardware DSP mic) but it
  // still detects speech.
  private readonly audioFilter: NoiseFilter;
  private readonly noiseFilterOn: boolean;

  // ---- Silence saver: Gemini bills audio input per second, silence
  // included, and every bridge receives the same audio — so don't stream
  // silence, and close the Gemini session entirely when nobody has spoken
  // for a while. SILENCE_SAVER=off restores always-on streaming (A/B tests).
  //
  // Pause: after PAUSE_AFTER_SILENCE_MS of silence stop sending audio. That
  // is longer than VAD's silenceDurationMs (800), so Gemini has already
  // closed the turn before input stops; audioStreamEnd is sent as well to
  // flush anything it still holds.
  private static readonly PAUSE_AFTER_SILENCE_MS = 1500;
  // Unfiltered audio kept while paused and sent ahead of the frame that
  // resumes the stream, so the onset of the first word isn't clipped.
  private static readonly PRE_ROLL_MS = 300;
  // Organizer frames stopped arriving (mic muted / left mid-sentence):
  // close out the stream so the last utterance still gets translated.
  private static readonly FRAME_STALL_MS = 1000;
  // Idle close: no speech for this long AND no Gemini output for
  // OUTPUT_SETTLE_MS (so the last translation has fully arrived).
  private static readonly IDLE_CLOSE_MS = 3 * 60_000;
  private static readonly OUTPUT_SETTLE_MS = 15_000;
  private static readonly IDLE_CHECK_INTERVAL_MS = 1000;
  // Max audio buffered while Gemini (re)connects; flushed in order on setup.
  private static readonly MAX_PENDING_MS = 30_000;
  private static readonly FRAME_MS = 50;
  private readonly silenceSaverOn: boolean;
  private streamPaused: boolean = true; // nothing to send until someone speaks
  private silenceMs: number = 0;
  private preRoll: Int16Array[] = [];
  private pendingAudio: Int16Array[] = [];
  private geminiIdle: boolean = false;
  private audioStreamEndUnsupported: boolean = false;
  private lastSpeechAt: number = Date.now();
  private lastFrameAt: number = 0;
  private lastGeminiOutputAt: number = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  // Guard against piping the same (or a second) organizer track twice —
  // duplicate read loops send audio to Gemini twice and garble translations
  private pipedTrack: RemoteAudioTrack | null = null;
  private activeAudioReader: ReadableStreamDefaultReader<AudioFrame> | null =
    null;

  // Transcription segmentation + runaway-repetition suppression
  private static readonly SEGMENT_GAP_MS = 1200;
  private static readonly MAX_SEGMENT_MS = 20_000;
  private static readonly MAX_CONSECUTIVE_REPEATS = 1;
  // Repeat-suppression above only mutes the transcript; it does nothing about
  // the model itself getting stuck re-generating the same phrase as audio.
  // Once a chunk repeats this many times, force a fresh Gemini session.
  private static readonly LOOP_BREAK_REPEATS = 3;
  private breakingLoop: boolean = false;
  private lastTranscriptionAt: number = 0;
  private segmentStartedAt: number = 0;
  private lastChunkText: Partial<Record<TranscriptionKind, string>> = {};
  private lastChunkRepeats: Partial<Record<TranscriptionKind, number>> = {};
  // Full "original" text of the current segment, used to catch Gemini
  // restarting a turn and re-stating what it just said — accumulates as
  // chunks arrive, snapshotted into `previousSegmentText` and reset each time
  // advanceSegment() runs.
  private currentSegmentText: string = "";
  private previousSegmentText: string = "";
  // Where each original chunk of the current segment starts in
  // currentSegmentText (see liveSentenceSplit)
  private originalChunkStarts: number[] = [];

  // ---- Hybrid mode (see TRANSLATION_MODE in translation-session-manager):
  // languages this bridge also serves as *text* translations, ref-counted
  // per subscriber. Utterances already in this bridge's own language get no
  // Live translation (Gemini emits silent audio for them), so once such a
  // segment ends its transcript is translated by a text model and published
  // as if it came from a `${textTarget}` bridge — the watch page needs no
  // special case. Their original text is mirrored live as it arrives.
  private textTargets: Map<string, number> = new Map();
  private segmentEndTimer: NodeJS.Timeout | null = null;
  private finalizedSegmentId: number = -1;
  private recentContext: ContextLine[] = [];
  private static readonly CONTEXT_LINES = 4;
  // Interim text translations: while a segment is still being spoken, its
  // text so far is re-translated (at most every INTERIM_INTERVAL_MS and only
  // after INTERIM_MIN_CHARS of new text) so the translation appears
  // progressively instead of only after the segment ends; finalizeSegment()'s
  // translation replaces it. The interval is shorter than a request takes
  // (~1-1.5s), so requests overlap; only a result newer than the one on
  // screen is shown (interimShownSeq). A handful of cheap text-model calls
  // per segment — INTERIM_TRANSLATION=off disables them.
  private static readonly INTERIM_INTERVAL_MS = 600;
  private static readonly INTERIM_MIN_CHARS = 10;
  private readonly interimTranslationOn: boolean;
  private interimSeq: number = 0;
  private interimShownSeq: number = 0;
  // The latest interim request. If the segment ends with exactly this text,
  // finalizeSegment() uses its result as the final translation instead of
  // making a second request, which saves a request and a round trip.
  private lastInterim: {
    segmentId: number;
    text: string;
    results: Map<string, Promise<string | null>>;
  } | null = null;
  private interimStartedAt: number = 0;
  private interimTextLength: number = 0;
  // Automatic sentence ends (hybrid text direction, see
  // publishTranscriptionText): a segment that ends on a sentence end is
  // closed after this much quiet instead of SEGMENT_GAP_MS.
  private static readonly SENTENCE_END_GAP_MS = 400;

  // Polish: Gemini Live translates piece by piece, so its Thai can lose
  // meaning, mix pronouns/particles or garble numbers, and its transcription
  // arrives with no spaces ("ดังนั้น,ฟังดูดีนะไทม์ไลน์…"). A text model corrects
  // it against the original speech (refineTranslation) sentence by sentence:
  // as soon as the translation completes a sentence (lastSentenceEnd), else
  // once it has gone quiet for POLISH_SETTLE_MS, and the rest when the segment
  // closes. Each call corrects only the new sentences, with the corrected
  // ones as context, and the row shows "corrected so far + raw rest". A
  // segment of continuous speech stays open for up to MAX_SEGMENT_MS (the
  // live-translate model sends no turnComplete), and Live chunks arrive about
  // once a second; correcting the whole segment and discarding the result
  // whenever more arrived meant nothing was corrected until the speaker
  // stopped. POLISH_SETTLE_MS is longer than the ~1-1.3 s between Live
  // chunks, so it means the speaker paused rather than a slow chunk (a
  // correction of half a sentence reads badly once the rest arrives).
  // POLISH_TRANSLATION=off disables it.
  private static readonly POLISH_LANGUAGES = ["th"];
  private static readonly POLISH_SETTLE_MS = 2000;
  private readonly polishOn: boolean;
  private currentTranslatedText: string = "";
  private liveRefine: LiveRefine = newLiveRefine(0);
  private polishTimer: NodeJS.Timeout | null = null;

  // ENGLISH_TERMS=off keeps originals exactly as Live transcribed them
  // (publishEnglishTerms)
  private readonly englishTermsOn: boolean;

  // NOTE: `sourceLanguageCodes` is NOT a valid field on this model's
  // translation_config — confirmed twice via "Unknown name 'sourceLanguageCodes'"
  // (code 1007) from the API. Do not re-add it without checking the current
  // Gemini Live API schema first.

  constructor(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string,
    config: {
      geminiApiKey: string;
      livekitUrl: string;
      livekitApiKey: string;
      livekitApiSecret: string;
    },
  ) {
    this.sessionId = sessionId;
    this.targetLanguage = targetLanguage;
    this.organizerIdentity = organizerIdentity;
    this.identity = `translator-${targetLanguage}`;
    this.geminiApiKey = config.geminiApiKey;
    this.livekitUrl = config.livekitUrl;
    this.livekitApiKey = config.livekitApiKey;
    this.livekitApiSecret = config.livekitApiSecret;
    this.noiseFilterOn = process.env.NOISE_FILTER !== "off";
    this.audioFilter = new NoiseFilter(this.inputSampleRate, {
      passthrough: !this.noiseFilterOn,
    });
    this.silenceSaverOn = process.env.SILENCE_SAVER !== "off";
    this.interimTranslationOn = process.env.INTERIM_TRANSLATION !== "off";
    this.polishOn = process.env.POLISH_TRANSLATION !== "off";
    this.englishTermsOn = process.env.ENGLISH_TERMS !== "off";
  }

  addTextTarget(language: string, count: number = 1): void {
    this.textTargets.set(
      language,
      (this.textTargets.get(language) ?? 0) + count,
    );
  }

  textTargetCount(language: string): number {
    return this.textTargets.get(language) ?? 0;
  }

  removeTextTarget(language: string): void {
    const n = (this.textTargets.get(language) ?? 0) - 1;
    if (n > 0) this.textTargets.set(language, n);
    else this.textTargets.delete(language);
  }

  get textTargetLanguages(): string[] {
    return [...this.textTargets.keys()];
  }

  async start(): Promise<void> {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Starting bridge for session ${this.sessionId}`,
    );

    try {
      // 1. Generate token and join LiveKit room
      await this.joinLiveKitRoom();

      // 2. Connect to Gemini Live API
      await this.openGeminiSocket();

      // 3. Subscribe to organizer's audio and wire up the pipeline
      await this.subscribeToOrganizer();

      this.status = "active";
      if (this.silenceSaverOn) {
        this.idleTimer = setInterval(
          () => this.checkIdle(),
          TranslationBridge.IDLE_CHECK_INTERVAL_MS,
        );
      }
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Bridge is active`,
      );
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Failed to start:`,
        error,
      );
      // Leave the room/socket too — otherwise the bot identity stays in the
      // LiveKit room and the next attempt for this language gets a 409.
      await this.stop().catch(() => {});
      this.status = "error";
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log(`[TranslationBridge:${this.targetLanguage}] Stopping bridge`);
    this.status = "closed";
    console.log(
      `[Usage] live ${this.targetLanguage} audio sent=${(this.samplesSentToGemini / this.inputSampleRate).toFixed(1)}s ` +
        `received=${(this.samplesReceivedFromGemini / this.sampleRate).toFixed(1)}s ` +
        `muted=${(this.samplesMuted / this.sampleRate).toFixed(1)}s`,
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.segmentEndTimer) {
      clearTimeout(this.segmentEndTimer);
      this.segmentEndTimer = null;
    }
    if (this.polishTimer) {
      clearTimeout(this.polishTimer);
      this.polishTimer = null;
    }
    this.pendingAudio = [];
    this.preRoll = [];

    if (this.activeAudioReader) {
      this.activeAudioReader.cancel().catch(() => {});
      this.activeAudioReader = null;
      this.pipedTrack = null;
    }

    if (this.geminiWs) {
      // Detach first so the close handler treats this socket as superseded
      // and doesn't try to reconnect it
      const ws = this.geminiWs;
      this.geminiWs = null;
      try {
        ws.close();
      } catch {
        // Already closing
      }
    }

    // Never throw from here: a failed disconnect (dead native handle) must
    // not leave the bridge stuck in the manager, unkillable. The Gemini side
    // is already closed above, which is what costs money.
    const room = this.room;
    this.room = null;
    this.audioSource = null;
    this.localTrack = null;
    this.geminiSetupComplete = false;
    if (room) {
      try {
        await withTimeout(
          room.disconnect(),
          TranslationBridge.DISCONNECT_TIMEOUT_MS,
          "LiveKit disconnect timed out",
        );
      } catch (error) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] Disconnect failed, abandoning room:`,
          error instanceof Error ? error.message : error,
        );
        retainFailedRoom(room);
      }
    }
  }

  private async joinLiveKitRoom(): Promise<void> {
    // Generate a token for the bot participant using the server SDK
    const { AccessToken } = await import("livekit-server-sdk");

    const at = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
      identity: this.identity,
      name: `Translator (${this.targetLanguage.toUpperCase()})`,
    });

    at.addGrant({
      roomJoin: true,
      room: this.sessionId,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    this.room = await this.connectRoomWithRetry(token);

    this.room.on(RoomEvent.Disconnected, () => {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Disconnected from room`,
      );
      // Kicked, room deleted, or server dropped us. Marking it closed alone
      // left the Gemini socket open (billed audio, no way to publish it), so
      // tear the rest down too. stop() sets "closed" first, which keeps its
      // own room.disconnect() from re-entering here.
      if (this.status !== "closed") {
        void this.stop().catch(() => {});
      }
    });

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Joined room as ${this.identity}`,
    );

    // Create an AudioSource to publish translated audio
    // Gemini outputs 24kHz mono PCM
    this.audioSource = new AudioSource(this.sampleRate, this.channels);
    this.localTrack = LocalAudioTrack.createAudioTrack(
      `translated-audio-${this.targetLanguage}`,
      this.audioSource,
    );

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await this.room.localParticipant!.publishTrack(
      this.localTrack,
      publishOptions,
    );

    // Save published track SID for transcription
    const pubs = this.room.localParticipant!.trackPublications;
    for (const [, pub] of pubs) {
      if (pub.track === this.localTrack) {
        this.publishedTrackSid = pub.sid || "";
        break;
      }
    }

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Published translated audio track (sid: ${this.publishedTrackSid || "pending"})`,
    );
  }

  /**
   * Connect a fresh Room, retrying when the native layer drops it mid-connect.
   *
   * rtc-node's FFI expects JS to acknowledge every successful connect
   * (ReadyForRoomEvent) within a short window; if the Node event loop is busy
   * at that moment the native side gives up and drops the room ("timed out
   * waiting for ReadyForRoomEventRequest"), and the ack then fails with
   * "handle not found (... ReadyForRoomEvent ...)". The LiveKit join itself
   * succeeded, so trying again on a new Room recovers.
   *
   * Measured: under `next start` connects take ~0.1-0.5s with ~30ms
   * event-loop delay and never hit this; under `next dev` the loop stalls
   * 0.3-2.7s and the 2nd bridge in a session often needs several attempts.
   */
  private async connectRoomWithRetry(token: string): Promise<Room> {
    for (let attempt = 1; ; attempt++) {
      const room = new Room();
      try {
        // The queue is shared by every session, so a connect that never
        // settles would block all later bridge joins. Bound it.
        await serializeRoomConnect(() =>
          withTimeout(
            room.connect(this.livekitUrl, token, {
              autoSubscribe: false,
              dynacast: false,
            }),
            TranslationBridge.CONNECT_TIMEOUT_MS,
            "LiveKit connect timed out",
          ),
        );
        return room;
      } catch (error) {
        // A timed-out connect may still complete later; make sure it leaves
        room.disconnect().catch(() => {});
        retainFailedRoom(room);
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt >= TranslationBridge.CONNECT_ATTEMPTS ||
          !message.includes("handle not found")
        ) {
          throw error;
        }
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] LiveKit connect dropped by native layer (attempt ${attempt}/${TranslationBridge.CONNECT_ATTEMPTS}) — retrying`,
        );
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }

  /**
   * Open a Gemini Live WebSocket and resolve once `setupComplete` arrives.
   * Used for both the initial connection and every reconnect (GoAway,
   * unexpected closure, stuck-loop reset) — the LiveKit room and audio
   * pipeline are reused; only the Gemini session is replaced.
   */
  private openGeminiSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${GEMINI_WS_URL}?key=${this.geminiApiKey}`);
      this.geminiWs = ws;
      this.geminiSetupComplete = false;

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        if (error) reject(error);
        else resolve();
      };
      const setupTimer = setTimeout(() => {
        settle(new Error("Gemini setup timeout"));
        // Force a close so an active bridge's close handler retries
        ws.terminate();
      }, TranslationBridge.SETUP_TIMEOUT_MS);

      ws.on("open", () => {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket connected`,
        );
        this.sendGeminiSetup(ws);
      });

      ws.on("message", (data: WebSocket.Data) => {
        // A superseded socket can still deliver a few late messages
        if (ws !== this.geminiWs) return;
        const wasReady = this.geminiSetupComplete;
        this.handleGeminiMessage(data);
        if (this.geminiSetupComplete) {
          settle();
          // Audio captured while connecting/reconnecting goes out first,
          // in order, so the session starts exactly where speech began
          if (!wasReady) this.flushPendingAudio();
        }
      });

      ws.on("error", (error) => {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket error:`,
          error,
        );
        settle(error);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket closed`,
          { code, reason: reasonStr },
        );
        settle(
          new Error(
            `Gemini WebSocket closed before setup: code=${code} reason=${reasonStr}`,
          ),
        );
        if (ws !== this.geminiWs) return;
        // If this model rejects the audioStreamEnd signal, stop sending it —
        // pausing still works without it (see PAUSE_AFTER_SILENCE_MS).
        if (/audio_?stream_?end/i.test(reasonStr)) {
          this.audioStreamEndUnsupported = true;
          console.warn(
            `[TranslationBridge:${this.targetLanguage}] Gemini rejected audioStreamEnd — pausing without it`,
          );
        }
        this.geminiSetupComplete = false;
        if (this.status === "active") {
          // Our own intentional closes (code 1000) reconnect immediately;
          // anything else backs off briefly before retrying.
          this.scheduleGeminiReconnect(
            code === 1000 ? 0 : TranslationBridge.RECONNECT_DELAY_MS,
          );
        }
      });
    });
  }

  private scheduleGeminiReconnect(delayMs: number): void {
    if (this.reconnectTimer) return;
    // A new Gemini session starts a new turn — don't glue its first words
    // onto the previous session's half-finished segment
    this.advanceSegment();
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Reconnecting Gemini WebSocket in ${delayMs}ms...`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status !== "active" || this.geminiIdle) return;
      this.openGeminiSocket().catch((error) => {
        // The socket's close handler schedules the next attempt
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Gemini reconnect failed:`,
          error instanceof Error ? error.message : error,
        );
      });
    }, delayMs);
  }

  private sendGeminiSetup(ws: WebSocket): void {
    const allowedNames = SOURCE_LANGUAGE_NAMES.map((l) => l.name).join(", ");
    const sourceNames = SOURCE_LANGUAGE_NAMES.filter(
      (l) => l.code !== this.targetLanguage,
    )
      .map((l) => l.name)
      .join(" and ");
    const setupMessage = {
      setup: {
        model: `models/${this.geminiModel}`,
        // Best-effort bias against source-language misdetection and noise:
        // translation_config has no field for this (see
        // SOURCE_LANGUAGE_NAMES comment above), so this is a soft nudge,
        // not a hard constraint — the script filter in
        // publishTranscriptionText is the actual backstop.
        systemInstruction: {
          parts: [
            {
              text:
                liveDomainPrompt(
                  sourceNames,
                  getLanguageByCode(this.targetLanguage)?.name ??
                    this.targetLanguage,
                ) +
                "\n\n" +
                `This is a live meeting where speakers switch freely between languages, ` +
                `often mid-conversation and sometimes mixing English terms into Thai sentences. ` +
                `The speakers only ever speak one of: ${allowedNames}. ` +
                `Detect the language of each utterance independently. ` +
                `Never identify or transcribe the source speech as any other language — ` +
                `if uncertain, pick whichever of ${allowedNames} is the closest match. ` +
                `Ignore background noise, coughs, typing and unintelligible side ` +
                `conversation: do not transcribe or translate anything that is not clear speech.`,
            },
          ],
        },
        outputAudioTranscription: {},
        // Every bridge transcribes its input: the watch page pairs each
        // utterance's original with its translation from the SAME Gemini
        // session, which is the only pairing that stays aligned (independent
        // sessions segment turns independently). languageCodes and
        // customVocabulary are accepted but don't stop it spelling English
        // words in Thai (see english-terms.ts).
        inputAudioTranscription: {},
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: this.targetLanguage,
            // Speech already in the target language is handled by the other
            // direction's bridge, so this bridge needn't echo it back.
            echoTargetLanguage: false,
          },
        },
        // VAD tuning (distinct JSON path from translation_config, unaffected
        // by the sourceLanguageCodes rejection above).
        //
        // HIGH end-of-speech sensitivity + a short silenceDurationMs was
        // tuned for lower lag assuming a single close-miked presenter with
        // few pauses. In an actual multi-speaker round-table meeting (8
        // attendees around one Jabra Speak2) that combo is too eager: a
        // normal mid-sentence pause (breath, hesitation, "เดี๋ยว...") reads as
        // end-of-speech, Gemini closes the turn early, and the next turn
        // restates the same context — the paraphrased/overlapping "duplicate"
        // segments seen in testing. Traded latency back for turn-taking
        // stability: 800ms silence needs a clearer, longer pause before
        // ending a turn.
        //
        // NOTE: previously also set startOfSpeechSensitivity: HIGH + a
        // prefixPaddingMs, intended to catch soft speech onsets from a
        // round-table Jabra setup. Reverted — HIGH start sensitivity made VAD
        // latch onto brief mid-sentence volume dips as new speech starts,
        // which is the same fragmentation failure mode as above. Only tune
        // start sensitivity again alongside a fix for that restatement
        // behavior (e.g. turnCoverage/context handling), not on its own.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            silenceDurationMs: 800,
          },
        },
      },
    };

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Sending Gemini setup:`,
      JSON.stringify(setupMessage, null, 2),
    );

    ws.send(JSON.stringify(setupMessage));
  }

  /** One [Usage] line per usageMetadata, with token counts by modality. */
  private logLiveUsage(usage: {
    promptTokenCount?: number;
    responseTokenCount?: number;
    totalTokenCount?: number;
    promptTokensDetails?: { modality?: string; tokenCount?: number }[];
    responseTokensDetails?: { modality?: string; tokenCount?: number }[];
  }): void {
    const byModality = (
      details?: { modality?: string; tokenCount?: number }[],
    ) =>
      (details ?? [])
        .map((d) => `${d.modality ?? "?"}:${d.tokenCount ?? 0}`)
        .join(",");
    console.log(
      `[Usage] live ${this.targetLanguage} in=${usage.promptTokenCount ?? 0}` +
        `[${byModality(usage.promptTokensDetails)}] ` +
        `out=${usage.responseTokenCount ?? 0}` +
        `[${byModality(usage.responseTokensDetails)}] ` +
        `total=${usage.totalTokenCount ?? 0}`,
    );
  }

  private handleGeminiMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Log all messages before setup is complete for debugging
      if (!this.geminiSetupComplete) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini message (pre-setup):`,
          JSON.stringify(message).slice(0, 500),
        );
      }

      // Handle setup complete
      if (message.setupComplete) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini setup complete`,
        );
        this.geminiSetupComplete = true;
        return;
      }

      if (message.usageMetadata) this.logLiveUsage(message.usageMetadata);

      // Handle audio response
      const serverContent = message?.serverContent;
      if (serverContent) this.lastGeminiOutputAt = Date.now();
      if (serverContent?.outputTranscription?.text) {
        this.lastTranslationChunkAt = Date.now();
      }
      const parts = serverContent?.modelTurn?.parts;

      if (parts?.length) {
        for (const part of parts) {
          if (part.inlineData?.data) {
            this.framesReceivedFromGemini++;
            // 16-bit mono: 2 bytes per sample
            this.samplesReceivedFromGemini +=
              Buffer.byteLength(part.inlineData.data, "base64") / 2;
            if (
              this.framesReceivedFromGemini <= 3 ||
              this.framesReceivedFromGemini % 100 === 0
            ) {
              console.log(
                `[TranslationBridge:${this.targetLanguage}] Received audio frame #${this.framesReceivedFromGemini} from Gemini (${part.inlineData.data.length} bytes base64)`,
              );
            }
            if (
              Date.now() - this.lastTranslationChunkAt >
              TranslationBridge.TRANSLATED_AUDIO_HOLD_MS
            ) {
              this.samplesMuted +=
                Buffer.byteLength(part.inlineData.data, "base64") / 2;
              continue;
            }
            // Queue frame for sequential capture (avoid promise pile-up)
            this.queueAudioFrame(part.inlineData.data);
          }
        }
      }

      // Handle input (source-language) transcription
      if (serverContent?.inputTranscription?.text) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Input transcription:`,
          serverContent.inputTranscription.text.slice(0, 100),
        );
        this.publishTranscriptionText(
          serverContent.inputTranscription.text,
          "original",
          !serverContent.turnComplete,
        );
      }

      // Handle output transcription (separate field from modelTurn)
      if (serverContent?.outputTranscription?.text) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Transcription:`,
          serverContent.outputTranscription.text.slice(0, 100),
        );
        this.publishTranscriptionText(
          serverContent.outputTranscription.text,
          "translated",
          !serverContent.turnComplete,
        );
      }

      // Advance the segment id when the turn ends or is interrupted (barge-in)
      if (serverContent?.turnComplete || serverContent?.interrupted) {
        this.advanceSegment();
      }
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error parsing Gemini message:`,
        error,
      );
    }
  }

  /**
   * Queue an audio frame for sequential capture.
   * Chains each captureFrame call to avoid promise pile-up.
   */
  private queueAudioFrame(base64Audio: string): void {
    this.captureChain = this.captureChain.then(() =>
      this.publishTranslatedAudio(base64Audio),
    );
  }

  private async publishTranslatedAudio(base64Audio: string): Promise<void> {
    if (!this.audioSource || this.status === "closed") return;

    try {
      const pcmBuffer = Buffer.from(base64Audio, "base64");
      const int16 = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.byteLength / 2,
      );

      const frame = new AudioFrame(
        int16,
        this.sampleRate,
        this.channels,
        int16.length,
      );
      await this.audioSource.captureFrame(frame);

      const now = Date.now();
      if (this.lastAudioFrameTime && now - this.lastAudioFrameTime > 2000) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Audio resumed after ${now - this.lastAudioFrameTime}ms gap (frame #${this.framesReceivedFromGemini})`,
        );
      }
      this.lastAudioFrameTime = now;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("InvalidState") || msg.includes("closed")) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] AudioSource closed — stopping capture`,
        );
        this.audioSource = null;
      } else {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Error capturing audio frame:`,
          error,
        );
      }
    }
  }

  private async subscribeToOrganizer(): Promise<void> {
    if (!this.room) return;

    // Pipe the organizer's audio to Gemini once subscribed (autoSubscribe is
    // off, so subscription is always triggered explicitly below)
    this.room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteAudioTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          participant.identity === this.organizerIdentity &&
          publication.kind === TrackKind.KIND_AUDIO
        ) {
          this.pipeTrackToGemini(track);
        }
      },
    );

    // Organizer (re)publishing later — e.g. joined after this bridge, or
    // toggled the mic off/on
    this.room.on(
      RoomEvent.TrackPublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (
          participant.identity === this.organizerIdentity &&
          publication.kind === TrackKind.KIND_AUDIO
        ) {
          publication.setSubscribed(true);
        }
      },
    );

    // Organizer already in the room
    const organizer = [...this.room.remoteParticipants.values()].find(
      (p) => p.identity === this.organizerIdentity,
    );
    if (organizer) {
      for (const [, publication] of organizer.trackPublications) {
        if (publication.kind === TrackKind.KIND_AUDIO) {
          publication.setSubscribed(true);
        }
      }
    } else {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Waiting for organizer ${this.organizerIdentity}...`,
      );
    }
  }

  private pipeTrackToGemini(track: RemoteAudioTrack): void {
    // TrackSubscribed can fire again for the same track (re-subscription after
    // a signaling hiccup) — never start a second read loop on it
    if (this.pipedTrack === track) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Already piping this organizer track — ignoring duplicate subscribe`,
      );
      return;
    }

    // A different track (organizer republished) replaces the old pipeline
    if (this.activeAudioReader) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Replacing previous audio pipeline`,
      );
      this.activeAudioReader.cancel().catch(() => {});
      this.activeAudioReader = null;
    }

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Subscribed to organizer audio track, piping to Gemini` +
        (this.noiseFilterOn ? " (noise filter on)" : "") +
        (this.silenceSaverOn ? " (silence saver on)" : ""),
    );

    const audioStream = new AudioStream(track, {
      sampleRate: this.inputSampleRate,
      numChannels: this.channels,
      frameSizeMs: 50,
    });

    // Process frames as they arrive via ReadableStream reader
    const reader = audioStream.getReader();
    this.pipedTrack = track;
    this.activeAudioReader = reader;
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        // Stop if this pipeline has been superseded by a newer one
        if (done || this.activeAudioReader !== reader) break;
        this.handleOrganizerFrame(value);
      }
    };

    readLoop().catch((err: Error) => {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Audio stream error:`,
        err,
      );
    });
  }

  /**
   * Filter one organizer frame and route it: stream it to Gemini, buffer it
   * while Gemini (re)connects, or — with the silence saver on — hold it back
   * during silence. See the PAUSE_AFTER_SILENCE_MS comment for the rules.
   */
  private handleOrganizerFrame(frame: AudioFrame): void {
    const pcm = this.audioFilter.process(frame.data);
    const now = Date.now();
    this.lastFrameAt = now;

    if (!this.silenceSaverOn) {
      this.sendOrBuffer(pcm);
      return;
    }

    const speech = this.audioFilter.gateOpen;
    if (speech) {
      this.lastSpeechAt = now;
      this.silenceMs = 0;
    } else {
      this.silenceMs += TranslationBridge.FRAME_MS;
    }

    if (this.streamPaused) {
      if (!speech) {
        // The unfiltered audio: while the gate is closed its output is
        // silence, which made the pre-roll useless and cut the first
        // syllable after every pause.
        this.preRoll.push(new Int16Array(frame.data));
        const maxFrames =
          TranslationBridge.PRE_ROLL_MS / TranslationBridge.FRAME_MS;
        if (this.preRoll.length > maxFrames) this.preRoll.shift();
        return;
      }
      // Speech resumed: wake Gemini if it was closed for idleness (audio is
      // buffered until it's ready), then send the pre-roll ahead of this frame
      this.streamPaused = false;
      if (this.geminiIdle) this.wakeGemini();
      for (const f of this.preRoll) this.sendOrBuffer(f);
      this.preRoll = [];
    }

    this.sendOrBuffer(pcm);

    if (this.silenceMs >= TranslationBridge.PAUSE_AFTER_SILENCE_MS) {
      this.pauseStream();
    }
  }

  private get geminiReady(): boolean {
    return (
      !!this.geminiWs &&
      this.geminiWs.readyState === WebSocket.OPEN &&
      this.geminiSetupComplete
    );
  }

  /** Send now if Gemini is ready, otherwise queue for flushPendingAudio(). */
  private sendOrBuffer(pcm: Int16Array): void {
    if (this.geminiReady && this.pendingAudio.length === 0) {
      this.sendAudioChunk(pcm);
      return;
    }
    this.pendingAudio.push(pcm);
    const maxFrames =
      TranslationBridge.MAX_PENDING_MS / TranslationBridge.FRAME_MS;
    if (this.pendingAudio.length > maxFrames) {
      this.pendingAudio.shift();
      if (this.pendingAudio.length === maxFrames) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] Gemini still not ready — dropping audio older than ${TranslationBridge.MAX_PENDING_MS / 1000}s`,
        );
      }
    }
    if (this.geminiReady) this.flushPendingAudio();
  }

  /** Send everything buffered while Gemini was (re)connecting, in order. */
  private flushPendingAudio(): void {
    if (!this.geminiReady || this.pendingAudio.length === 0) return;
    const frames = this.pendingAudio;
    this.pendingAudio = [];
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Flushing ${frames.length * TranslationBridge.FRAME_MS}ms of audio buffered while Gemini connected`,
    );
    // Batch into ~500ms chunks — fewer messages, same audio
    for (let i = 0; i < frames.length; i += 10) {
      const batch = frames.slice(i, i + 10);
      const merged = new Int16Array(batch.reduce((n, f) => n + f.length, 0));
      let offset = 0;
      for (const f of batch) {
        merged.set(f, offset);
        offset += f.length;
      }
      this.sendAudioChunk(merged);
    }
  }

  private sendAudioChunk(pcm: Int16Array): void {
    try {
      const base64 = Buffer.from(
        pcm.buffer,
        pcm.byteOffset,
        pcm.byteLength,
      ).toString("base64");

      this.framesSentToGemini++;
      this.samplesSentToGemini += pcm.length;
      if (this.framesSentToGemini <= 3 || this.framesSentToGemini % 500 === 0) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Sent audio frame #${this.framesSentToGemini} to Gemini (${base64.length} bytes base64, ${pcm.length} samples)`,
        );
      }

      const message = {
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
            data: base64,
          },
        },
      };

      this.geminiWs!.send(JSON.stringify(message));
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error sending audio to Gemini:`,
        error,
      );
    }
  }

  /** Stop streaming silence; Gemini has already ended the turn by now. */
  private pauseStream(): void {
    if (this.streamPaused) return;
    this.streamPaused = true;
    this.preRoll = [];
    if (this.geminiReady && !this.audioStreamEndUnsupported) {
      try {
        this.geminiWs!.send(
          JSON.stringify({ realtimeInput: { audioStreamEnd: true } }),
        );
      } catch {
        // Socket closing — the reconnect path handles it
      }
    }
  }

  /** Runs every IDLE_CHECK_INTERVAL_MS while the silence saver is on. */
  private checkIdle(): void {
    if (this.status !== "active") return;
    const now = Date.now();

    // Organizer frames stopped mid-utterance (mic muted, tab closed): Gemini
    // never hears the trailing silence its VAD needs, so supply it, then
    // pause — otherwise the last sentence would never be translated.
    if (
      !this.streamPaused &&
      this.lastFrameAt &&
      now - this.lastFrameAt > TranslationBridge.FRAME_STALL_MS
    ) {
      const silence = new Int16Array(
        (this.inputSampleRate * TranslationBridge.PAUSE_AFTER_SILENCE_MS) /
          1000,
      );
      this.sendOrBuffer(silence);
      this.pauseStream();
    }

    if (
      !this.geminiIdle &&
      this.geminiWs &&
      this.streamPaused &&
      this.pendingAudio.length === 0 &&
      now - this.lastSpeechAt > TranslationBridge.IDLE_CLOSE_MS &&
      now - this.lastGeminiOutputAt > TranslationBridge.OUTPUT_SETTLE_MS
    ) {
      this.closeGeminiForIdle();
    }
  }

  /** Close the Gemini session (not the LiveKit side) until speech returns. */
  private closeGeminiForIdle(): void {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] No speech for ${TranslationBridge.IDLE_CLOSE_MS / 60_000} min — closing Gemini session until someone speaks`,
    );
    this.geminiIdle = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.geminiWs;
    // Detach first so the close handler doesn't reconnect it
    this.geminiWs = null;
    this.geminiSetupComplete = false;
    ws?.close(1000, "idle");
  }

  /** Reopen Gemini on speech; frames buffer in pendingAudio meanwhile. */
  private wakeGemini(): void {
    if (!this.geminiIdle) return;
    this.geminiIdle = false;
    this.advanceSegment();
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Speech detected — reopening Gemini session`,
    );
    this.openGeminiSocket().catch((error) => {
      // The socket's close handler schedules a retry while status is active
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Gemini wake failed:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  /** Start a new utterance segment and reset per-segment dedupe state. */
  private advanceSegment(): void {
    this.finalizeSegment();
    this.closeLiveSegment();
    this.transcriptionSegmentId++;
    this.segmentStartedAt = 0;
    this.lastChunkText = {};
    this.lastChunkRepeats = {};
    this.interimTextLength = 0;
    this.currentTranslatedText = "";
    this.liveRefine = newLiveRefine(this.transcriptionSegmentId);
    if (this.currentSegmentText) {
      this.previousSegmentText = this.currentSegmentText;
    }
    this.currentSegmentText = "";
    this.originalChunkStarts = [];
  }

  /**
   * Force a fresh Gemini WebSocket when the model gets stuck re-generating
   * the same phrase as audio. Closing with code 1000 (status stays "active")
   * makes the socket's close handler reconnect immediately, reusing the
   * LiveKit room/audio pipeline — only the Gemini session itself is replaced.
   */
  private breakGeminiLoop(): void {
    if (this.breakingLoop || !this.geminiWs) return;
    this.breakingLoop = true;
    this.advanceSegment();
    this.geminiWs.close(1000, "stuck-loop-detected");
    // Give the reconnect time to land before this can trigger again.
    setTimeout(() => {
      this.breakingLoop = false;
    }, 3000);
  }

  /**
   * Hybrid: whether the current segment is in this bridge's own language
   * and so gets text-translated here — the only segments split at sentence
   * ends. A Live-translated segment must stay open until its translation
   * has arrived (it lags the original), or late chunks would land on the
   * next segment; those still end on Gemini's turns and the gap/time caps.
   */
  private splitsSentences(text: string = ""): boolean {
    return (
      this.textTargets.size > 0 &&
      detectLanguage(this.currentSegmentText + text) === this.targetLanguage
    );
  }

  /**
   * Where to close a Live-translated row, given a new translated chunk: if
   * the chunk completes a sentence of the translation (lastSentenceEnd) and
   * the original has a sentence end (lastPunctuationEnd), the row ends at
   * both. The translation lags the original by about one chunk, so when it
   * completes a sentence the original sentence it renders has already
   * ended, and anything after that end ("How" of the next question) belongs
   * to the next row. Without an end in the original (Thai is transcribed
   * without punctuation) the row stays open and ends on a pause as before.
   */
  private liveSentenceSplit(chunk: string): {
    translated: string;
    translatedRest: string;
    original: string;
    originalRest: string;
  } | null {
    const original = this.currentSegmentText;
    if (!original.trim() || detectLanguage(original) === this.targetLanguage) {
      return null;
    }
    const before = this.currentTranslatedText.length;
    const end = lastSentenceEnd(this.currentTranslatedText + chunk, 0);
    if (end <= before) return null;
    const originalEnd = lastPunctuationEnd(original);
    // The end must lie in the last two original chunks. An earlier one
    // means the translation caught up with a later sentence the original
    // hasn't ended yet ("…ได้ไหมครับ?" before "gate?" arrived): cutting at
    // "Good morning." moved the whole question to a row of its own, with no
    // translation.
    const starts = this.originalChunkStarts;
    if (
      originalEnd < 0 ||
      originalEnd <= (starts.length >= 2 ? starts[starts.length - 2] : 0) ||
      original.slice(0, originalEnd).trim().length < MIN_SENTENCE_CHARS
    ) {
      return null;
    }
    return {
      translated: chunk.slice(0, end - before),
      translatedRest: chunk.slice(end - before),
      original: original.slice(0, originalEnd),
      originalRest: original.slice(originalEnd),
    };
  }

  private async publishTranscriptionText(
    text: string,
    kind: TranscriptionKind,
    interim: boolean,
    splitSentences: boolean = true,
  ): Promise<void> {
    if (!this.room || !this.room.localParticipant) return;

    // Backstop for source-language misdetection (see SOURCE_LANGUAGE_NAMES):
    // the systemInstruction bias in sendGeminiSetup is only a nudge, so still
    // drop "original" chunks whose script proves Gemini locked onto a language
    // outside th/en/ja (e.g. Vietnamese) rather than showing attendees garbled
    // or mislabeled source text.
    if (kind === "original" && hasDisallowedScript(text)) {
      console.warn(
        `[TranslationBridge:${this.targetLanguage}] Dropping original-language chunk with disallowed script:`,
        text.slice(0, 100),
      );
      return;
    }

    // turnComplete rarely accompanies transcription chunks, so segments would
    // otherwise grow forever — treat a lull in transcription output as an
    // utterance boundary and start a new segment.
    //
    // Only "original" (input) chunks drive this: translation always lags a
    // beat behind transcription (it takes time to translate what was just
    // heard), so gating on "any chunk of either kind" meant a normal
    // translation-latency pause looked like a lull — advanceSegment() fired
    // mid-utterance, the just-arrived translated text got attached to a
    // fresh segment (orphaning its original, i.e. "not translated"), and the
    // next original chunk for the SAME utterance started yet another new
    // segment with dedupe state wiped, so a near-identical restatement wasn't
    // caught as a repeat (i.e. the "overlapping/duplicate segment" symptom).
    // Translated chunks just attach to whatever segment is currently open.
    const now = Date.now();
    if (kind === "original") {
      if (
        this.lastTranscriptionAt &&
        now - this.lastTranscriptionAt > TranslationBridge.SEGMENT_GAP_MS
      ) {
        this.advanceSegment();
      }
      this.lastTranscriptionAt = now;

      // Cap segment duration so a pair never spans much more than a minute
      if (this.segmentStartedAt === 0) {
        this.segmentStartedAt = now;
      } else if (
        now - this.segmentStartedAt >
        TranslationBridge.MAX_SEGMENT_MS
      ) {
        this.advanceSegment();
        this.segmentStartedAt = now;
      }

      // Someone answered in the other language without a pause: a new
      // utterance. Joined to the last one, a Thai reply could tip an English
      // row's majority language to Thai, hiding the whole row on the watch
      // page (its source would equal its target).
      if (switchesLanguage(this.currentSegmentText, text)) {
        this.advanceSegment();
        this.segmentStartedAt = now;
      }

      // Even with the VAD/segment-timing fixes above, Gemini can still close
      // a turn on a natural mid-sentence pause and then re-open a new turn
      // that re-states the tail of what it just said before continuing with
      // genuinely new content (e.g. two segments both opening with "ในขณะที่
      // กระทรวงการคลังออกมาเปิดเผยกับว่าการ..." before diverging) — this is
      // Gemini itself restarting recognition, not something the local
      // segment/gap logic can prevent. Catch it here instead: if the opening
      // chunk of a (just-started) segment shares a long common prefix with
      // the immediately preceding segment's full text, it's a restatement,
      // not new speech — drop it rather than show a near-duplicate line.
      if (
        this.currentSegmentText === "" &&
        this.previousSegmentText &&
        commonPrefixLength(text.trim(), this.previousSegmentText) >=
          RESTART_DUPLICATE_MIN_OVERLAP
      ) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] Dropping ${kind} chunk that restates the previous segment:`,
          text.slice(0, 100),
        );
        return;
      }

      // A sentence ended inside this chunk (see sentence-boundary.ts): close
      // the segment there — it's translated right away — and open the next
      // one with the rest. The head is published unsplit (it already ends
      // at the break); the rest may hold further sentence ends.
      if (splitSentences && this.splitsSentences(text)) {
        const cut = findSentenceBreak(this.currentSegmentText, text);
        if (cut >= 0) {
          const head = text.slice(0, cut);
          if (head.trim()) {
            await this.publishTranscriptionText(head, kind, interim, false);
          }
          this.advanceSegment();
          return this.publishTranscriptionText(text.slice(cut), kind, interim);
        }
      }
      this.originalChunkStarts.push(this.currentSegmentText.length);
      this.currentSegmentText += text;

      // Hybrid: the segment counts as finished once originals go quiet for
      // the same gap that would start a new segment — translate it then
      // rather than waiting for the next utterance to arrive. A sentence
      // that has ended only needs a short quiet to confirm it; that path
      // advances rather than just finalizing, since speech arriving before
      // SEGMENT_GAP_MS would otherwise join a segment already translated.
      if (this.textTargets.size > 0) {
        if (this.segmentEndTimer) clearTimeout(this.segmentEndTimer);
        const ended =
          this.splitsSentences() && endsSentence(this.currentSegmentText);
        this.segmentEndTimer = setTimeout(
          () => {
            this.segmentEndTimer = null;
            if (ended) this.advanceSegment();
            else this.finalizeSegment();
          },
          ended
            ? TranslationBridge.SENTENCE_END_GAP_MS
            : TranslationBridge.SEGMENT_GAP_MS,
        );
      }
    }

    // A Live translation completed a sentence: close the row there, with the
    // original up to its last sentence end (see liveSentenceSplit). The
    // original that already ran ahead moves to the next row, and so does the
    // rest of this chunk. Ahead of the repeat check below, which would take
    // the head (often the whole chunk) for a repeat of this chunk and drop it.
    if (kind === "translated" && splitSentences) {
      const split = this.liveSentenceSplit(text);
      if (split) {
        if (split.translated.trim()) {
          void this.publishTranscriptionText(
            split.translated,
            kind,
            interim,
            false,
          );
        }
        if (split.originalRest) {
          this.currentSegmentText = split.original;
          void this.publishMessage({
            language: this.targetLanguage,
            segmentId: this.liveSegmentId(this.transcriptionSegmentId),
            kind: "original",
            text: split.original,
            final: false,
            replace: true,
          });
        }
        this.advanceSegment();
        if (split.originalRest.trim()) {
          void this.publishTranscriptionText(
            split.originalRest.trimStart(),
            "original",
            true,
            false,
          );
        }
        return split.translatedRest.trim()
          ? this.publishTranscriptionText(split.translatedRest, kind, interim)
          : undefined;
      }
    }

    // Suppress runaway repetition (e.g. the model stuck in a feedback loop
    // emitting the same word endlessly): allow a chunk to repeat consecutively
    // a couple of times, then drop further identical chunks
    // Normalize text (trim whitespace) to prevent " Okay?" and "Okay?" from bypassing check
    const normalizedText = text.trim();

    if (normalizedText === this.lastChunkText[kind]) {
      const repeats = (this.lastChunkRepeats[kind] ?? 1) + 1;
      this.lastChunkRepeats[kind] = repeats;
      if (repeats === TranslationBridge.LOOP_BREAK_REPEATS) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] Detected stuck loop ` +
            `(${kind} repeated "${normalizedText}" ${repeats}x) — forcing Gemini reconnect`,
        );
        this.breakGeminiLoop();
      }
      if (repeats > TranslationBridge.MAX_CONSECUTIVE_REPEATS) return;
    } else {
      this.lastChunkText[kind] = normalizedText;
      this.lastChunkRepeats[kind] = 1;
    }

    if (kind === "translated") {
      this.currentTranslatedText += text;
      if (this.polishes) {
        if (this.polishTimer) clearTimeout(this.polishTimer);
        // A sentence completed: correct it now. Correct the rest once the
        // translation goes quiet — also what a completed sentence left over
        // (refineStep may wait for the English to end a sentence first).
        if (
          lastSentenceEnd(this.currentTranslatedText, this.liveRefine.done) > 0
        ) {
          this.polishTranslation(false);
        }
        this.polishTimer = setTimeout(() => {
          this.polishTimer = null;
          this.polishTranslation(true);
        }, TranslationBridge.POLISH_SETTLE_MS);
      }
    }
    await this.publishMessage({
      language: this.targetLanguage,
      segmentId: this.liveSegmentId(this.transcriptionSegmentId),
      kind,
      text,
      final: !interim,
    });

    // Hybrid: mirror originals of an utterance in this bridge's own language
    // to the text-target segments right away, so the speaker's words show up
    // live; the translation follows when the segment ends (finalizeSegment).
    if (
      kind === "original" &&
      this.textTargets.size > 0 &&
      detectLanguage(this.currentSegmentText) === this.targetLanguage
    ) {
      for (const target of this.textTargets.keys()) {
        await this.publishMessage({
          language: target,
          segmentId: this.textSegmentId(target, this.transcriptionSegmentId),
          kind: "original",
          text,
          final: false,
        });
      }
      this.translateInterim();
    }
  }

  /**
   * Hybrid: translate the still-open segment's text so far and publish it as
   * a non-final translation (see INTERIM_INTERVAL_MS). Results that land
   * after the segment was finalized or advanced, or after a newer request's
   * result, are dropped, so the final translation always wins.
   */
  private translateInterim(): void {
    const now = Date.now();
    const segmentId = this.transcriptionSegmentId;
    const text = this.currentSegmentText.trim();
    if (this.finalizedSegmentId === segmentId) return;
    // The text ends on a firm sentence end, so the segment closes with
    // exactly this text in SENTENCE_END_GAP_MS. Translate it now as the final
    // version, without throttling: finalizeSegment() reuses the result
    // (lastInterim), so the gap costs no latency and no extra request.
    const ended = this.splitsSentences() && endsSentence(text);
    if (ended) {
      if (
        this.lastInterim?.segmentId === segmentId &&
        this.lastInterim.text === text
      ) {
        return;
      }
    } else if (
      !this.interimTranslationOn ||
      now - this.interimStartedAt < TranslationBridge.INTERIM_INTERVAL_MS ||
      text.length - this.interimTextLength < TranslationBridge.INTERIM_MIN_CHARS
    ) {
      return;
    }

    const seq = ++this.interimSeq;
    this.interimStartedAt = now;
    this.interimTextLength = text.length;
    const context = [...this.recentContext];
    const targets = [...this.textTargets.keys()].filter(
      (t) => t !== this.targetLanguage,
    );

    const results = new Map(
      targets.map((target) => [
        target,
        translateText({
          apiKey: this.geminiApiKey,
          text,
          from: this.targetLanguage,
          to: target,
          context,
          partial: !ended,
        }),
      ]),
    );
    this.lastInterim = { segmentId, text, results };

    for (const [target, pending] of results) {
      void pending.then((translation) => {
        if (
          !translation ||
          seq < this.interimShownSeq ||
          this.status === "closed" ||
          this.transcriptionSegmentId !== segmentId ||
          this.finalizedSegmentId === segmentId
        ) {
          return;
        }
        this.interimShownSeq = seq;
        return this.publishMessage({
          language: target,
          segmentId: this.textSegmentId(target, segmentId),
          kind: "translated",
          text: translation,
          final: false,
          replace: true,
        });
      });
    }
  }

  /** Segment id of this bridge's own (Live session) output. */
  private liveSegmentId(segmentId: number): string {
    return `${this.targetLanguage}-${this.segmentPrefix}${segmentId}`;
  }

  /** Whether this bridge's Live output gets re-spaced (POLISH_LANGUAGES). */
  private get polishes(): boolean {
    return (
      this.polishOn &&
      TranslationBridge.POLISH_LANGUAGES.includes(this.targetLanguage)
    );
  }

  /**
   * Correct the current Live segment's completed sentences (or, with
   * `toEnd`, everything it has so far) — see the Polish comment.
   */
  private polishTranslation(toEnd: boolean): void {
    if (this.polishTimer) {
      clearTimeout(this.polishTimer);
      this.polishTimer = null;
    }
    const r = this.liveRefine;
    r.draft = this.currentTranslatedText;
    r.original = this.currentSegmentText;
    this.refineStep(r, toEnd);
  }

  /**
   * The segment is closing: correct what's left and mark its row final. A
   * Live row only becomes final this way, so a segment that isn't corrected
   * (POLISH_TRANSLATION=off, no original yet) is published final as it is.
   */
  private closeLiveSegment(): void {
    if (this.polishTimer) {
      clearTimeout(this.polishTimer);
      this.polishTimer = null;
    }
    const r = this.liveRefine;
    r.draft = this.currentTranslatedText;
    r.original = this.currentSegmentText;
    r.closed = true;
    if (!r.draft.trim()) return;
    if (this.refines(r)) {
      this.refineStep(r, true);
    } else if (detectLanguage(r.original) !== this.targetLanguage) {
      void this.publishMessage({
        language: this.targetLanguage,
        segmentId: this.liveSegmentId(r.segmentId),
        kind: "translated",
        text: r.draft,
        final: true,
        replace: true,
      });
    }
  }

  /** Whether segment `r` gets corrected at all. */
  private refines(r: LiveRefine): boolean {
    const original = r.original.trim();
    // Speech already in this language: the watch page doesn't show this
    // segment (its source equals its target), so don't pay to correct it.
    return (
      this.polishes &&
      !!original &&
      detectLanguage(original) !== this.targetLanguage
    );
  }

  /**
   * One correction request for segment `r`: the draft from `r.done` up to
   * its last completed sentence (or its end, with `toEnd` or once the
   * segment is closed). One request at a time per segment; a trigger while
   * one is in flight runs again when it returns, so no result is thrown
   * away. A failed request keeps that part as the Live text.
   */
  private refineStep(r: LiveRefine, toEnd: boolean): void {
    if (!this.refines(r) || this.status === "closed") return;
    if (r.busy) {
      r.again = true;
      r.againToEnd ||= toEnd;
      return;
    }
    const whole = toEnd || r.closed;
    // The English is cut at its last sentence end. With none yet (Live put
    // ครับ after "Good morning," and the speaker goes on), the model got
    // English past the Thai sentence, translated into it, and that part
    // showed twice. Leave it to the settle run or the close.
    if (!whole && lastPunctuationEnd(r.original.trim()) < 0) return;
    const end = whole ? r.draft.length : lastSentenceEnd(r.draft, r.done);
    const tail = end > r.done ? r.draft.slice(r.done, end).trim() : "";
    if (!tail) {
      if (whole) void this.publishCorrected(r);
      return;
    }
    r.busy = true;
    void refineTranslation({
      apiKey: this.geminiApiKey,
      // Up to the sentence the draft ends on (see untilLastSentenceEnd)
      original: whole
        ? r.original.trim()
        : untilLastSentenceEnd(r.original.trim()),
      draft: tail,
      corrected: r.corrected || undefined,
    }).then((corrected) => {
      r.busy = false;
      r.corrected = joinText(r.corrected, corrected ?? formatTranscript(tail));
      r.done = end;
      if (this.status === "closed") return;
      // Live chunks that arrived meanwhile belong after the corrected part
      if (r === this.liveRefine && !r.closed) {
        r.draft = this.currentTranslatedText;
        r.original = this.currentSegmentText;
      }
      const again = r.again || (r.closed && r.done < r.draft.length);
      const againToEnd = r.againToEnd || r.closed;
      r.again = false;
      r.againToEnd = false;
      void this.publishCorrected(r);
      if (again) this.refineStep(r, againToEnd);
    });
  }

  /**
   * Show segment `r` as "corrected so far + the Live text after it", final
   * once all of it is corrected. Live segments only close when the next
   * utterance starts, so waiting for that left the last row looking
   * unfinished. Live chunks that arrive later append to this (the draft only
   * ever grows) and, being non-final, turn the row back into an unfinished
   * one.
   */
  private publishCorrected(r: LiveRefine): Promise<void> {
    const rest = r.draft.slice(r.done).trim();
    const text = joinText(r.corrected, rest);
    const final = !rest && !r.busy;
    // Unchanged since the last publish (e.g. a closing run with nothing left)
    const key = `${final}|${text}|${r.draft.length}`;
    if (key === r.published) return Promise.resolve();
    r.published = key;
    return this.publishMessage({
      language: this.targetLanguage,
      segmentId: this.liveSegmentId(r.segmentId),
      kind: "translated",
      text,
      final,
      replace: true,
    });
  }

  /** Segment id under which a hybrid text translation is published. */
  private textSegmentId(target: string, segmentId: number): string {
    return `${target}~${this.targetLanguage}-${this.segmentPrefix}${segmentId}`;
  }

  /**
   * Close out the current segment: remember it as context, and in hybrid
   * mode translate it by text when it's in this bridge's own language (the
   * Live session produced no translation for it). Idempotent per segment.
   */
  private finalizeSegment(): void {
    if (this.segmentEndTimer) {
      clearTimeout(this.segmentEndTimer);
      this.segmentEndTimer = null;
    }
    const segmentId = this.transcriptionSegmentId;
    const text = this.currentSegmentText.trim();
    if (!text || this.finalizedSegmentId === segmentId) return;
    this.finalizedSegmentId = segmentId;

    const source = detectLanguage(text);
    const context = [...this.recentContext];
    if (source) {
      this.recentContext.push({ language: source, text });
      if (this.recentContext.length > TranslationBridge.CONTEXT_LINES) {
        this.recentContext.shift();
      }
    }

    if (source === "th") this.publishEnglishTerms(text, segmentId);

    if (source !== this.targetLanguage || this.textTargets.size === 0) return;

    for (const target of this.textTargets.keys()) {
      if (target === source) continue;
      const id = this.textSegmentId(target, segmentId);
      // Replace the live-mirrored chunks with the full original — covers
      // any opening chunks published before the language was detectable
      void this.publishMessage({
        language: target,
        segmentId: id,
        kind: "original",
        text,
        final: true,
        replace: true,
      });
      const interim =
        this.lastInterim?.segmentId === segmentId &&
        this.lastInterim.text === text
          ? this.lastInterim.results.get(target)
          : undefined;
      void (async () =>
        (interim && (await interim)) ||
        translateText({
          apiKey: this.geminiApiKey,
          text,
          from: source,
          to: target,
          context,
        }))().then((translation) => {
        if (this.status === "closed") return;
        if (!translation) {
          console.warn(
            `[TranslationBridge:${this.targetLanguage}] Text translation to ${target} failed for segment ${segmentId}`,
          );
          return;
        }
        return this.publishMessage({
          language: target,
          segmentId: id,
          kind: "translated",
          text: translation,
          final: true,
          replace: true,
        });
      });
    }
  }

  /**
   * Replace a finished Thai original with one whose English words are in Latin
   * letters (see english-terms.ts). It reaches the row wherever that row is:
   * under a text target's id, or under this bridge's own id if it is a Live
   * translation of the Thai. The translation doesn't wait for this.
   */
  private publishEnglishTerms(text: string, segmentId: number): void {
    if (!this.englishTermsOn) return;
    const rows: [string, string][] =
      this.targetLanguage === "th"
        ? [...this.textTargets.keys()]
            .filter((target) => target !== "th")
            .map((target) => [target, this.textSegmentId(target, segmentId)])
        : [[this.targetLanguage, this.liveSegmentId(segmentId)]];
    if (!rows.length) return;
    void restoreEnglishTerms({ apiKey: this.geminiApiKey, text }).then(
      (restored) => {
        if (!restored || this.status === "closed") return;
        for (const [language, id] of rows) {
          void this.publishMessage({
            language,
            segmentId: id,
            kind: "original",
            text: restored,
            final: true,
            replace: true,
          });
        }
      },
    );
  }

  private async publishMessage(
    fields: Omit<TranscriptionMessage, "type" | "timestamp">,
  ): Promise<void> {
    if (!this.room?.localParticipant) return;
    try {
      const message: TranscriptionMessage = {
        type: "transcription",
        ...fields,
        timestamp: Date.now(),
      };
      await this.room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify(message)),
        { reliable: true, topic: "transcription" },
      );
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error publishing transcription:`,
        error,
      );
    }
  }
}

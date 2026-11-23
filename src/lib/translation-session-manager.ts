/**
 * TranslationSessionManager: Singleton that enforces "max 1 Gemini Live API
 * session per language per room" constraint.
 *
 * Usage:
 *   const manager = TranslationSessionManager.getInstance();
 *   const bridge = await manager.getOrCreate(sessionId, targetLanguage, organizerIdentity);
 */

import { TranslationBridge, BridgeStatus } from "./translation-bridge";
import { DEFAULT_PAIR, isSupportedLanguage, SUPPORTED_LANGUAGES } from "./languages";

export interface TranslationInfo {
  language: string;
  translatorIdentity: string;
  status: BridgeStatus;
  subscriberCount: number;
  /** Languages this bridge also serves as text translations (hybrid mode). */
  textTargets: string[];
}

/**
 * TRANSLATION_MODE:
 * - "hybrid" (default): one Live session per room for HYBRID_PAIR, targeting
 *   the session's voice language (the side that needs to *hear*
 *   translations; starts as HYBRID_AUDIO_LANGUAGE, default "th", and the
 *   organizer can switch it — see setAudioLanguage). Subscribers of the
 *   pair's other language get text translations from that one bridge
 *   instead of a second Live session (see TranslationBridge textTargets).
 *   Roughly halves Gemini cost: a Live session bills per second of input
 *   audio even for speech it doesn't translate, and emits billed *silent*
 *   output for it.
 * - "dual": one Live session per language (audio both ways, ~2x cost).
 */
export type TranslationMode = "hybrid" | "dual";
const TRANSLATION_MODE: TranslationMode =
  process.env.TRANSLATION_MODE === "dual" ? "dual" : "hybrid";
const HYBRID_PAIR: readonly string[] = DEFAULT_PAIR.filter(isSupportedLanguage);
const HYBRID_AUDIO_LANGUAGE = HYBRID_PAIR.includes(process.env.HYBRID_AUDIO_LANGUAGE ?? "")
  ? process.env.HYBRID_AUDIO_LANGUAGE!
  : HYBRID_PAIR[0];

export class UnsupportedLanguageError extends Error {
  constructor(language: string) {
    super(
      `Unsupported language "${language}". Supported: ${SUPPORTED_LANGUAGES.map((l) => l.code).join(", ")}`
    );
    this.name = "UnsupportedLanguageError";
  }
}

/** Refuse a language outside SUPPORTED_LANGUAGES before any Gemini cost. */
function assertSupported(language: string): void {
  if (!isSupportedLanguage(language)) {
    throw new UnsupportedLanguageError(language);
  }
}

export interface Subscription {
  bridge: TranslationBridge;
  /** False when served as text by another language's bridge (hybrid). */
  audio: boolean;
}

export interface SessionInfo {
  sessionId: string;
  organizerIdentity: string;
  createdAt: Date;
  /** Hybrid mode: the pair language that gets the Live session (a voice). */
  audioLanguage: string;
}

export interface AudioConfig {
  mode: TranslationMode;
  /** Languages that share the one hybrid Live session. */
  pair: readonly string[];
  audioLanguage: string;
}

// Cached on globalThis so the instance (and its live bridges/Gemini sockets)
// survives Next.js dev-mode HMR module re-evaluation. A plain static field
// gets wiped on every recompile, orphaning sessions whose LiveKit rooms are
// still alive ("Session not found").
const globalStore = globalThis as unknown as {
  __translationSessionManager?: TranslationSessionManager;
};

class TranslationSessionManager {
  // Map<sessionId, Map<languageCode, TranslationBridge>>
  private translations: Map<string, Map<string, TranslationBridge>> = new Map();

  // Map<sessionId, SessionInfo>
  private sessions: Map<string, SessionInfo> = new Map();

  // Map<`${sessionId}:${language}`, in-flight getOrCreate promise> — de-dupes
  // concurrent requests for the same bridge so a second request arriving
  // while the first is still starting doesn't spawn a duplicate bridge with
  // the same LiveKit identity (which LiveKit rejects with HTTP 409).
  private pendingCreates: Map<string, Promise<TranslationBridge>> = new Map();

  // Map<sessionId, tail of that session's hybrid operations>. Subscribe,
  // unsubscribe and voice switches for HYBRID_PAIR languages run one at a
  // time, so a switch never has to account for a half-counted subscriber.
  private hybridLocks: Map<string, Promise<unknown>> = new Map();

  private constructor() {}

  static getInstance(): TranslationSessionManager {
    if (!globalStore.__translationSessionManager) {
      globalStore.__translationSessionManager = new TranslationSessionManager();
    } else {
      // After a dev-mode hot reload the cached instance still has the old
      // class's methods, so fixes would not apply until a restart. Its state
      // (sessions, live bridges) is plain fields; just swap the methods.
      Object.setPrototypeOf(
        globalStore.__translationSessionManager,
        TranslationSessionManager.prototype
      );
    }
    return globalStore.__translationSessionManager;
  }

  /**
   * Stop a bridge that is already out of the maps. Never throws: a bridge
   * that fails to stop cleanly must not block the caller (Kill, End session)
   * or stay listed.
   */
  private async stopQuietly(bridge: TranslationBridge): Promise<void> {
    try {
      await bridge.stop();
    } catch (error) {
      console.error(
        `[SessionManager] Bridge ${bridge.identity} did not stop cleanly:`,
        error
      );
    }
  }

  /** Remove (session, language) from the map and return what was there. */
  private detachBridge(
    sessionId: string,
    language: string
  ): TranslationBridge | undefined {
    const languageMap = this.translations.get(sessionId);
    const bridge = languageMap?.get(language);
    if (languageMap && bridge) {
      languageMap.delete(language);
      if (languageMap.size === 0) this.translations.delete(sessionId);
    }
    return bridge;
  }

  /**
   * Drop bridges whose LiveKit room or Gemini start failed ("closed" /
   * "error"). They cannot serve anyone and only linger in the lists until
   * the next subscribe happens to clean them up.
   */
  async pruneDeadBridges(): Promise<void> {
    for (const [sessionId, languageMap] of [...this.translations]) {
      for (const [language, bridge] of [...languageMap]) {
        if (bridge.status !== "closed" && bridge.status !== "error") continue;
        console.warn(
          `[SessionManager] Pruning ${bridge.status} bridge ${language} in session ${sessionId}`
        );
        this.detachBridge(sessionId, language);
        await this.stopQuietly(bridge);
      }
    }
  }

  // Session management
  createSession(
    sessionId: string,
    organizerIdentity: string,
    createdAt: Date = new Date()
  ): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      organizerIdentity,
      createdAt,
      audioLanguage: HYBRID_AUDIO_LANGUAGE,
    };
    this.sessions.set(sessionId, info);
    console.log(`[SessionManager] Created session ${sessionId} for organizer ${organizerIdentity}`);
    return info;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAudioConfig(sessionId: string): AudioConfig {
    return {
      mode: TRANSLATION_MODE,
      pair: HYBRID_PAIR,
      audioLanguage: this.audioLanguageOf(sessionId),
    };
  }

  private audioLanguageOf(sessionId: string): string {
    return this.sessions.get(sessionId)?.audioLanguage ?? HYBRID_AUDIO_LANGUAGE;
  }

  /** Whether `language` is served by the session's one hybrid bridge. */
  private isHybrid(language: string): boolean {
    return TRANSLATION_MODE === "hybrid" && HYBRID_PAIR.includes(language);
  }

  private withHybridLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.hybridLocks.get(sessionId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.hybridLocks.set(sessionId, tail);
    tail.then(() => {
      if (this.hybridLocks.get(sessionId) === tail) this.hybridLocks.delete(sessionId);
    });
    return run;
  }

  /**
   * Subscribe an attendee to `targetLanguage`. In hybrid mode a pair
   * language other than the session's voice language is served as text by
   * the voice language's bridge.
   */
  async subscribe(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string
  ): Promise<Subscription> {
    assertSupported(targetLanguage);
    if (!this.isHybrid(targetLanguage)) {
      const bridge = await this.getOrCreate(sessionId, targetLanguage, organizerIdentity);
      return { bridge, audio: true };
    }

    return this.withHybridLock(sessionId, async () => {
      const audioLanguage = this.audioLanguageOf(sessionId);
      const bridge = await this.getOrCreate(sessionId, audioLanguage, organizerIdentity);
      if (targetLanguage === audioLanguage) return { bridge, audio: true };
      bridge.addTextTarget(targetLanguage);
      console.log(
        `[SessionManager] Serving ${targetLanguage} as text via the ${audioLanguage} bridge in session ${sessionId}`
      );
      return { bridge, audio: false };
    });
  }

  /**
   * Hybrid mode: move the session's one Live session (the voice) to the
   * other pair language. The new bridge starts before the old one stops, so
   * subtitles keep flowing, and it takes over every subscriber: the old
   * voice language's listeners become its text target and vice versa.
   */
  async setAudioLanguage(sessionId: string, language: string): Promise<void> {
    if (TRANSLATION_MODE !== "hybrid") {
      throw new Error("Switching the voice language needs TRANSLATION_MODE=hybrid");
    }
    if (!HYBRID_PAIR.includes(language)) {
      throw new Error(`Voice language must be one of: ${HYBRID_PAIR.join(", ")}`);
    }

    return this.withHybridLock(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      // Sessions created before this field existed (dev HMR) lack it
      const previous = session.audioLanguage ?? HYBRID_AUDIO_LANGUAGE;
      if (previous === language) return;
      session.audioLanguage = language;

      const old = this.translations.get(sessionId)?.get(previous);
      if (!old) return; // nobody subscribed yet — the next subscribe uses it

      const total = old.subscriberCount;
      const listeners = total - old.textTargetCount(language);
      if (total > 0) {
        let next: TranslationBridge;
        try {
          next = await this.createBridge(sessionId, language, session.organizerIdentity);
        } catch (error) {
          session.audioLanguage = previous;
          throw error;
        }
        next.subscriberCount = total;
        if (listeners > 0) next.addTextTarget(previous, listeners);
      }

      this.detachBridge(sessionId, previous);
      await this.stopQuietly(old);
      console.log(
        `[SessionManager] Switched voice language ${previous} -> ${language} in session ${sessionId}`
      );
    });
  }

  // Translation management
  async getOrCreate(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string
  ): Promise<TranslationBridge> {
    // Check if we already have a bridge for this language
    const languageMap = this.translations.get(sessionId);
    if (languageMap) {
      const existingBridge = languageMap.get(targetLanguage);
      if (existingBridge && existingBridge.status === "active") {
        console.log(
          `[SessionManager] Reusing existing bridge for ${targetLanguage} in session ${sessionId}`
        );
        existingBridge.subscriberCount++;
        return existingBridge;
      }
      // If bridge exists but is in error/closed state, clean it up
      if (existingBridge && (existingBridge.status === "error" || existingBridge.status === "closed")) {
        console.log(
          `[SessionManager] Cleaning up stale bridge for ${targetLanguage}`
        );
        this.detachBridge(sessionId, targetLanguage);
        await this.stopQuietly(existingBridge);
      }
    }

    // A bridge for this (session, language) is already being created —
    // join that in-flight creation instead of starting a second bridge with
    // the same LiveKit identity (which LiveKit would reject with a 409).
    const pendingKey = `${sessionId}:${targetLanguage}`;
    const pending = this.pendingCreates.get(pendingKey);
    if (pending) {
      console.log(
        `[SessionManager] Joining in-flight bridge creation for ${targetLanguage} in session ${sessionId}`
      );
      const bridge = await pending;
      bridge.subscriberCount++;
      return bridge;
    }

    const createPromise = this.createBridge(sessionId, targetLanguage, organizerIdentity);
    this.pendingCreates.set(pendingKey, createPromise);
    try {
      const bridge = await createPromise;
      bridge.subscriberCount = 1;
      return bridge;
    } finally {
      this.pendingCreates.delete(pendingKey);
    }
  }

  private async createBridge(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string
  ): Promise<TranslationBridge> {
    assertSupported(targetLanguage);
    console.log(
      `[SessionManager] Creating new bridge for ${targetLanguage} in session ${sessionId}`
    );

    const config = {
      geminiApiKey: process.env.GEMINI_API_KEY!,
      livekitUrl: process.env.LIVEKIT_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL || "ws://localhost:7880",
      livekitApiKey: process.env.LIVEKIT_API_KEY!,
      livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
    };

    const bridge = new TranslationBridge(
      sessionId,
      targetLanguage,
      organizerIdentity,
      config
    );

    // Never overwrite a bridge that is still in the map: it would keep its
    // Gemini session and LiveKit bot running unseen, translating the same
    // room twice.
    const replaced = this.detachBridge(sessionId, targetLanguage);
    if (replaced) {
      console.warn(
        `[SessionManager] Replacing existing ${targetLanguage} bridge in session ${sessionId}`
      );
      await this.stopQuietly(replaced);
    }

    // Store the bridge before starting (to prevent race conditions)
    let languageMap = this.translations.get(sessionId);
    if (!languageMap) {
      languageMap = new Map();
      this.translations.set(sessionId, languageMap);
    }
    languageMap.set(targetLanguage, bridge);

    try {
      await bridge.start();
      return bridge;
    } catch (error) {
      // Clean up on failure (bridge.start() already left the room)
      languageMap.delete(targetLanguage);
      if (languageMap.size === 0) this.translations.delete(sessionId);
      throw error;
    }
  }

  getActiveTranslations(sessionId: string): TranslationInfo[] {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return [];

    const result: TranslationInfo[] = [];
    for (const [language, bridge] of languageMap) {
      result.push({
        language,
        translatorIdentity: bridge.identity,
        status: bridge.status,
        subscriberCount: bridge.subscriberCount,
        textTargets: bridge.textTargetLanguages,
      });
    }
    return result;
  }

  /**
   * Decrement subscriber count for a language. If the last subscriber
   * leaves, stop the bridge and tear down the Gemini session.
   */
  async unsubscribe(
    sessionId: string,
    targetLanguage: string
  ): Promise<void> {
    if (!this.isHybrid(targetLanguage)) {
      return this.releaseBridge(sessionId, targetLanguage);
    }
    return this.withHybridLock(sessionId, async () => {
      // Served by the voice language's bridge: a text subscriber also
      // drops its text target
      const audioLanguage = this.audioLanguageOf(sessionId);
      if (targetLanguage !== audioLanguage) {
        this.translations.get(sessionId)?.get(audioLanguage)?.removeTextTarget(targetLanguage);
      }
      await this.releaseBridge(sessionId, audioLanguage);
    });
  }

  /** Drop one subscriber from a bridge; stop it when none remain. */
  private async releaseBridge(
    sessionId: string,
    targetLanguage: string
  ): Promise<void> {
    // Let an in-flight creation finish first: its subscriber isn't counted
    // until start() resolves, so decrementing now would tear down a bridge
    // that is about to gain its first listener (e.g. an attendee switching
    // the pair back and forth quickly).
    const pending = this.pendingCreates.get(`${sessionId}:${targetLanguage}`);
    if (pending) await pending.catch(() => {});

    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return;

    const bridge = languageMap.get(targetLanguage);
    if (!bridge) return;

    bridge.subscriberCount = Math.max(0, bridge.subscriberCount - 1);
    console.log(
      `[SessionManager] Unsubscribed from ${targetLanguage} in session ${sessionId} (${bridge.subscriberCount} remaining)`
    );

    if (bridge.subscriberCount === 0) {
      console.log(
        `[SessionManager] No more subscribers for ${targetLanguage}, tearing down bridge`
      );
      this.detachBridge(sessionId, targetLanguage);
      await this.stopQuietly(bridge);
    }
  }

  async removeTranslation(
    sessionId: string,
    targetLanguage: string
  ): Promise<void> {
    const bridge = this.detachBridge(sessionId, targetLanguage);
    if (bridge) {
      await this.stopQuietly(bridge);
      console.log(
        `[SessionManager] Removed bridge for ${targetLanguage} in session ${sessionId}`
      );
    }
  }

  async removeAllTranslations(sessionId: string): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (languageMap) {
      // Out of the map first, so a bridge that fails to stop is not left
      // behind as an unkillable entry
      this.translations.delete(sessionId);
      for (const [, bridge] of languageMap) {
        await this.stopQuietly(bridge);
      }
      languageMap.clear();
    }
    // The record goes even when no bridge ever started, or ending a session
    // that nobody had requested a language in would leave it listed forever
    this.sessions.delete(sessionId);
    console.log(
      `[SessionManager] Removed all bridges and session for ${sessionId}`
    );
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }
}

export default TranslationSessionManager;

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type BridgeState =
  | { status: "starting" }
  | { status: "active" }
  | { status: "error"; error: string };

const UNSUBSCRIBE_URL = "/api/translate/unsubscribe";
const AUTO_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 2000;

/**
 * Keeps this attendee subscribed to one translation bridge per language in
 * `languages` (the server ref-counts subscribers and tears a bridge down when
 * its last one leaves). Changing `languages` unsubscribes from dropped ones
 * and subscribes to new ones; tab close is handled with sendBeacon because a
 * normal fetch isn't reliably delivered during unload.
 */
export function useTranslationBridges(sessionId: string, languages: string[]) {
  const [states, setStates] = useState<Record<string, BridgeState>>({});
  // lang → settles true once the server has counted our subscription. An
  // unsubscribe waits on it so it can never overtake its own subscribe.
  const subsRef = useRef<Map<string, Promise<boolean>>>(new Map());

  const setState = useCallback((lang: string, state: BridgeState | null) => {
    setStates((prev) => {
      const next = { ...prev };
      if (state) next[lang] = state;
      else delete next[lang];
      return next;
    });
  }, []);

  const subscribe = useCallback(
    (lang: string) => {
      setState(lang, { status: "starting" });

      const attemptRequest = (attempt: number): Promise<boolean> => {
        const request: Promise<boolean> = fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, targetLanguage: lang }),
        })
          .then(async (res) => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Translation request failed");
            if (subsRef.current.get(lang) === request) {
              setState(lang, { status: "active" });
            }
            return true;
          })
          .catch((err: Error) => {
            if (subsRef.current.get(lang) !== request) return false;
            if (attempt > AUTO_RETRIES) {
              console.error(`Translation request error (${lang}):`, err);
              setState(lang, { status: "error", error: err.message });
              return false;
            }
            // Transient server-side start failures happen (bot join races,
            // Gemini setup hiccups) — retry quietly before surfacing them.
            // The retry's promise replaces this one in subsRef, so a later
            // unsubscribe waits on whichever attempt is current.
            console.warn(`Translation request failed (${lang}), retrying:`, err.message);
            return new Promise<boolean>((resolve) => {
              setTimeout(() => {
                if (subsRef.current.get(lang) !== request) return resolve(false);
                resolve(attemptRequest(attempt + 1));
              }, AUTO_RETRY_DELAY_MS * attempt);
            });
          });
        subsRef.current.set(lang, request);
        return request;
      };

      attemptRequest(1);
    },
    [sessionId, setState]
  );

  const unsubscribe = useCallback(
    (lang: string) => {
      const request = subsRef.current.get(lang);
      if (!request) return;
      subsRef.current.delete(lang);
      setState(lang, null);
      request.then((counted) => {
        if (!counted) return;
        fetch(UNSUBSCRIBE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, targetLanguage: lang }),
          keepalive: true,
        }).catch(() => {});
      });
    },
    [sessionId, setState]
  );

  // Reconcile subscriptions with the requested languages
  const languagesKey = languages.join(",");
  useEffect(() => {
    const wanted = new Set(languagesKey.split(",").filter(Boolean));
    for (const lang of [...subsRef.current.keys()]) {
      if (!wanted.has(lang)) unsubscribe(lang);
    }
    for (const lang of wanted) {
      if (!subsRef.current.has(lang)) subscribe(lang);
    }
  }, [languagesKey, subscribe, unsubscribe]);

  // Leave every bridge on unmount (in-app navigation) and on tab close
  useEffect(() => {
    const subs = subsRef.current;
    const handleBeforeUnload = () => {
      for (const lang of subs.keys()) {
        navigator.sendBeacon(
          UNSUBSCRIBE_URL,
          new Blob([JSON.stringify({ sessionId, targetLanguage: lang })], {
            type: "application/json",
          })
        );
      }
      subs.clear();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      for (const lang of [...subs.keys()]) unsubscribe(lang);
    };
  }, [sessionId, unsubscribe]);

  /** Re-request every bridge that failed (e.g. once the organizer joins). */
  const retryFailed = useCallback(() => {
    for (const [lang, state] of Object.entries(states)) {
      if (state.status === "error") subscribe(lang);
    }
  }, [states, subscribe]);

  return { bridges: states, retry: subscribe, retryFailed };
}

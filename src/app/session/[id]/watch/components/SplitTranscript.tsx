"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptGroup } from "@/lib/transcription";
import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  getLanguageByCode,
} from "@/lib/languages";
import { formatTranscript } from "@/lib/text-format";
import type { BridgeState } from "../hooks/useTranslationBridges";
import { ArrowDownIcon, EyeIcon, EyeOffIcon, MicIcon, SwapIcon } from "./icons";

export type LanguagePair = [string, string];

export interface Cell {
  role: "original" | "translated";
  text: string;
  /** Source text shown above a translation whose source has no column. */
  caption?: { lang: string; text: string };
}

export interface Row {
  id: string;
  time: string;
  cells: [Cell | null, Cell | null];
  final: boolean;
}

// Rows this close to the end still show a typing indicator while their
// translation is pending; older rows that never got one just stay blank.
const PENDING_WINDOW = 3;

/**
 * Turn per-bridge utterance groups into split-screen rows.
 *
 * Each bridge (one per column language) transcribes every utterance, so the
 * same speech arrives up to twice. Keep a group only when its detected source
 * language differs from its bridge's target: Thai speech is shown from the
 * "en" bridge, English speech from the "th" bridge. Echo groups (source ==
 * target) are dropped — the other bridge owns that utterance. Filtering
 * uses the raw text; the cells get display formatting (spacing and
 * punctuation the transcription chunks lack — see text-format.ts). The
 * transcript download uses the same rows, so the file matches the screen.
 */
export function buildRows(
  groups: TranscriptGroup[],
  pair: LanguagePair,
  formatTime: (g: TranscriptGroup) => string
): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    const targetSide = pair.indexOf(g.language);
    const original = g.original.trim();
    if (targetSide < 0 || !original) continue;

    const source = detectLanguage(original);
    if (!source || source === g.language) continue;

    const translated = g.translated.trim();
    if (translated.toLowerCase() === original.toLowerCase()) continue;

    const sourceSide = pair.indexOf(source);
    const cells: Row["cells"] = [null, null];
    const shownOriginal = formatTranscript(original);
    cells[targetSide] = {
      role: "translated",
      text: formatTranscript(translated),
      caption: sourceSide < 0 ? { lang: source, text: shownOriginal } : undefined,
    };
    if (sourceSide >= 0) cells[sourceSide] = { role: "original", text: shownOriginal };

    rows.push({ id: g.id, time: formatTime(g), cells, final: g.final });
  }
  return rows;
}

interface SplitTranscriptProps {
  groups: TranscriptGroup[];
  formatTime: (g: TranscriptGroup) => string;
  pair: LanguagePair;
  onPairChange: (pair: LanguagePair) => void;
  /** Column language the reader has hidden, if any (at most one). */
  hiddenLang: string | null;
  onHiddenLangChange: (lang: string | null) => void;
  bridges: Record<string, BridgeState>;
  /** Languages with a translated voice in the room right now. */
  audioLanguages: string[];
  onRetry: (lang: string) => void;
  placeholder: string;
}

export default function SplitTranscript({
  groups,
  formatTime,
  pair,
  onPairChange,
  hiddenLang,
  onHiddenLangChange,
  bridges,
  audioLanguages,
  onRetry,
  placeholder,
}: SplitTranscriptProps) {
  const hiddenSide = hiddenLang ? pair.indexOf(hiddenLang) : -1;
  const sides: (0 | 1)[] =
    hiddenSide === 0 ? [1] : hiddenSide === 1 ? [0] : [0, 1];
  const single = sides.length === 1;
  const onlySide = single ? sides[0] : null;

  const rows = useMemo(() => {
    const all = buildRows(groups, pair, formatTime);
    // One column: drop utterances that have nothing on the visible side
    return onlySide === null ? all : all.filter((r) => r.cells[onlySide]);
  }, [groups, pair, formatTime, onlySide]);

  // Follow new rows only while the reader is at the bottom — don't yank
  // them away from something they scrolled up to re-read.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [rows, following, onlySide]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const setSide = (side: 0 | 1, lang: string) => {
    // Single column: picking the hidden language shows it in place of the
    // current one (a swap would just move it to the hidden side)
    if (single && lang === hiddenLang) {
      onHiddenLangChange(pair[side]);
      return;
    }
    const other = pair[side === 0 ? 1 : 0];
    // Picking the other column's language swaps the columns
    if (lang === other) onPairChange([pair[1], pair[0]]);
    else onPairChange(side === 0 ? [lang, other] : [other, lang]);
  };

  return (
    <section
      className={`split${single ? " split--single" : ""}`}
      aria-label="Live subtitles"
    >
      <div className="split-head">
        {sides.map((side) => (
          <ColumnHead
            key={side}
            side={side}
            lang={pair[side]}
            state={bridges[pair[side]]}
            hasVoice={audioLanguages.includes(pair[side])}
            onChange={(lang) => setSide(side, lang)}
            onRetry={() => onRetry(pair[side])}
            onHide={single ? undefined : () => onHiddenLangChange(pair[side])}
          />
        ))}
        {single && hiddenLang ? (
          <button
            type="button"
            className="split-show"
            onClick={() => onHiddenLangChange(null)}
            title={`Show the ${getLanguageByCode(hiddenLang)?.name ?? hiddenLang} column`}
          >
            <EyeIcon />
            {getLanguageByCode(hiddenLang)?.nativeName ?? hiddenLang.toUpperCase()}
          </button>
        ) : (
          <button
            type="button"
            className="split-swap"
            onClick={() => onPairChange([pair[1], pair[0]])}
            aria-label="Swap sides"
            title="Swap sides"
          >
            <SwapIcon />
          </button>
        )}
      </div>

      <div
        className={`split-body${rows.length === 0 ? " split-body--empty" : ""}`}
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {rows.length === 0 ? (
          <p className="split-empty">{placeholder}</p>
        ) : (
          rows.map((row, i) => {
            const current = i === rows.length - 1;
            const mayBePending = i >= rows.length - PENDING_WINDOW;
            return (
              <div
                key={row.id}
                className={`split-row${current ? " split-row--current" : ""}${
                  row.final ? "" : " split-row--interim"
                }`}
                aria-current={current || undefined}
              >
                {sides.map((side) => (
                  <CellView
                    key={side}
                    cell={row.cells[side]}
                    time={row.time}
                    pending={mayBePending}
                    live={current}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      {!following && rows.length > 0 && (
        <button
          type="button"
          className="split-jump"
          onClick={() => setFollowing(true)}
        >
          <ArrowDownIcon /> Latest
        </button>
      )}
    </section>
  );
}

function ColumnHead({
  side,
  lang,
  state,
  hasVoice,
  onChange,
  onRetry,
  onHide,
}: {
  side: 0 | 1;
  lang: string;
  state: BridgeState | undefined;
  hasVoice: boolean;
  onChange: (lang: string) => void;
  onRetry: () => void;
  /** Absent when this is the only visible column. */
  onHide?: () => void;
}) {
  const name = getLanguageByCode(lang)?.name ?? lang;
  return (
    <div className={`split-col-head split-col-head--${side === 0 ? "left" : "right"}`}>
      <label className="split-lang">
        <span className="split-code">{lang.toUpperCase()}</span>
        <select
          value={lang}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${side === 0 ? "Left" : "Right"} column language`}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.nativeName}
            </option>
          ))}
        </select>
      </label>

      {state?.status === "starting" && (
        <span className="bridge-state bridge-state--starting">
          <span className="status-dot pulse" /> Connecting
        </span>
      )}
      {state?.status === "error" && (
        <button
          type="button"
          className="bridge-state bridge-state--error"
          onClick={onRetry}
          title={state.error}
        >
          <span className="status-dot" /> Retry
        </button>
      )}
      {state?.status === "active" && (
        <span
          className="bridge-state bridge-state--active"
          title={
            hasVoice
              ? `${name} translation active (text + audio)`
              : `${name} subtitles only (no audio)`
          }
        >
          <span className="status-dot" />
          {!hasVoice && "Text"}
        </span>
      )}

      {onHide && (
        <button
          type="button"
          className="split-hide"
          onClick={onHide}
          aria-label={`Hide the ${name} column`}
          title={`Hide the ${name} column`}
        >
          <EyeOffIcon />
        </button>
      )}
    </div>
  );
}

function CellView({
  cell,
  time,
  pending,
  live,
}: {
  cell: Cell | null;
  time: string;
  pending: boolean;
  /** The utterance being spoken now: shown large, new words highlighted. */
  live: boolean;
}) {
  if (!cell) return <div className="split-cell" />;

  return (
    <div className={`split-cell split-cell--${cell.role}`}>
      {cell.role === "original" && (
        <span className="split-meta">
          <MicIcon size={12} /> {time}
        </span>
      )}
      {cell.caption && (
        <p className="split-caption">
          <span className="split-tag">{cell.caption.lang.toUpperCase()}</span>
          {cell.caption.text}
        </p>
      )}
      {cell.text ? (
        <p className="split-text">
          {live ? <LiveText text={cell.text} /> : cell.text}
        </p>
      ) : (
        pending && (
          <span className="typing" aria-label="Translating">
            <span />
            <span />
            <span />
          </span>
        )
      )}
    </div>
  );
}

interface FreshMark {
  id: number;
  start: number;
  end: number;
}

// Highlights older than this many chunks have long finished fading
const MAX_MARKS = 8;

/**
 * Text that grows chunk by chunk as it is spoken. Each newly arrived chunk
 * is wrapped in its own span whose highlight fades out (CSS), so the words
 * just spoken stand out without the earlier ones snapping back. A rewrite
 * (an interim translation replaced by the final one) highlights only the
 * part after the common prefix.
 */
function LiveText({ text }: { text: string }) {
  const [state, setState] = useState<{ text: string; marks: FreshMark[]; next: number }>(
    { text: "", marks: [], next: 0 }
  );

  // Derive the new marks during render (React's "adjust state when a prop
  // changes" pattern) so the highlight shows on the same frame as the text
  if (state.text !== text) {
    const prefix = commonPrefixLength(state.text, text);
    const kept = state.marks
      .filter((m) => m.start < prefix)
      .map((m) => (m.end > prefix ? { ...m, end: prefix } : m));
    const marks =
      prefix < text.length
        ? [...kept, { id: state.next, start: prefix, end: text.length }]
        : kept;
    setState({ text, marks: marks.slice(-MAX_MARKS), next: state.next + 1 });
  }

  const parts: ReactNode[] = [];
  let pos = 0;
  for (const m of state.marks) {
    if (m.end > text.length) break; // stale until the state update lands
    if (m.start > pos) parts.push(text.slice(pos, m.start));
    parts.push(
      <span key={m.id} className="split-fresh">
        {text.slice(m.start, m.end)}
      </span>
    );
    pos = m.end;
  }
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

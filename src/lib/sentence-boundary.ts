/**
 * Sentence boundaries in a live speech transcript, so the bridge can close
 * an utterance (and translate it) as soon as a sentence ends instead of
 * waiting for the speaker to pause.
 *
 * Gemini transcribes English/Japanese with punctuation but Thai without it,
 * so Thai sentence ends are recognized by their final particles. Pure
 * TypeScript, no I/O.
 */

// A sentence ends at terminal punctuation or a Thai final particle that is
// followed by whitespace. ครับ/ค่ะ end a sentence even with no space after
// them (Thai transcripts often run on) — neither occurs inside other words;
// "ครับผม" is one particle. The weaker particles need the space: "คะ" is
// also the start of "คะแนน", "ไหม" of "ไหมพรม". A full stop after a digit is
// not an end: Gemini splits "87.5" into the chunks "87." and "5", and
// breaking there translated it as "87 percent" plus a stray "5".
const BREAK =
  /(?:ครับผม|ครับ|ค่ะ)|(?:(?<!\d)\.|[!?。！？]|นะคะ|คะ|จ้ะ|จ้า|ไหม|มั้ย|หรือเปล่า|หรือยัง)(?=\s)/g;

// A sentence that ends on one of these is complete. Question words and
// softer particles (ไหม, หรือเปล่า, นะ…) are usually followed by a polite
// particle ("มีคำถามไหม ครับ"), so they don't count on their own.
const ENDS_SENTENCE = /(?:(?<!\d)\.|[!?。！？]|ครับผม|ครับ|ค่ะ|คะ)$/;

// Particles that continue a sentence after a sentence end ("…ไหม ครับ").
// Thai transcription chunks arrive about a second apart, so the particle is
// often still on its way: a break is also held while the text after it could
// be the start of one.
const TRAILING_PARTICLES = ["ครับผม", "ครับ", "ค่ะ", "คะ", "นะคะ", "นะครับ", "นะ", "จ้ะ", "จ้า"];

function startsWithParticle(rest: string): boolean {
  return TRAILING_PARTICLES.some((p) => rest.startsWith(p) || p.startsWith(rest));
}

/**
 * Shortest text kept as a sentence of its own. Short openers and replies
 * ("สวัสดีครับ" is 10, "ได้ครับ" 7) join the next sentence instead, which
 * reads and translates better than a one-phrase row.
 */
export const MIN_SENTENCE_CHARS = 12;

/**
 * Past this length with no sentence end, break anyway, so a run-on utterance
 * still comes in readable pieces and gets translated: at the last space in
 * the new chunk, or, for Thai with no space at all, before the chunk. (Thai
 * transcription has no punctuation, so a sentence without a final particle
 * used to wait for the bridge's 20 s cap.)
 */
export const MAX_SENTENCE_CHARS = 100;

/**
 * Where in `chunk` the next sentence starts, given the sentence so far
 * (`current`): `chunk.slice(0, cut)` finishes the current sentence and
 * `chunk.slice(cut)` opens the next. Returns -1 when the chunk doesn't end
 * the sentence, or when the end is the last thing in it (nothing follows
 * yet; a short pause settles that — see endsSentence).
 */
export function findSentenceBreak(current: string, chunk: string): number {
  const text = current + chunk;
  const from = current.length;

  BREAK.lastIndex = 0;
  for (let m = BREAK.exec(text); m; m = BREAK.exec(text)) {
    const end = m.index + m[0].length;
    let start = end;
    while (start < text.length && /\s/.test(text[start])) start++;
    if (start < from || start >= text.length) continue;
    if (text.slice(0, end).trim().length < MIN_SENTENCE_CHARS) continue;
    if (startsWithParticle(text.slice(start))) continue;
    return start - from;
  }

  if (text.trim().length > MAX_SENTENCE_CHARS) {
    const space = chunk.trimEnd().search(/\s\S*$/);
    if (space > 0) {
      let start = space;
      while (start < chunk.length && /\s/.test(chunk[start])) start++;
      return start;
    }
    if (current.trim().length >= MIN_SENTENCE_CHARS) return 0;
  }
  return -1;
}

// Sentence ends in a Live translation into Thai, which arrives unspaced but
// with "?"/"." from the model. "คะ" is left out: it also ends a clause inside
// a question ("…ได้ไหมคะว่าตู้…"), and a real question ends with "?" anyway.
const LIVE_END = /(?:ครับผม|ครับ|ค่ะ|(?<!\d)[.!?])/g;

const ENGLISH_END = /(?<!\d)[.!?]/g;

/**
 * `text` up to its last sentence end (all of it if there is none). When a
 * Live translation completes a sentence, the English it translates has
 * already ended (the translation lags), so this is the English it covers;
 * given the English beyond, the corrector kept translating into it and the
 * next correction repeated that part.
 */
export function untilLastSentenceEnd(text: string): string {
  const end = lastPunctuationEnd(text);
  return end > 0 ? text.slice(0, end) : text;
}

/** Index just past the last `.`/`?`/`!` sentence end in `text`, or -1. */
export function lastPunctuationEnd(text: string): number {
  let end = -1;
  ENGLISH_END.lastIndex = 0;
  for (let m = ENGLISH_END.exec(text); m; m = ENGLISH_END.exec(text)) {
    end = m.index + 1;
  }
  return end;
}

const THAI_LETTER = /[฀-๿]/g;
const LATIN_LETTER = /[A-Za-z]/g;
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

// A Thai speaker carries over English nouns and verbs, not its grammar.
const ENGLISH_GRAMMAR =
  /\b(?:the|is|are|was|were|am|do|does|did|i|you|we|they|he|she|it|have|has|had|can|could|would|should|will|this|that|these|those|what|who|why|how|when|where)\b/i;

/** English that is its own clause ("Do you", "Great."), not a term ("override"). */
function isEnglishClause(chunk: string): boolean {
  return (
    // Acronyms aren't grammar ("IT" is not "it")
    ENGLISH_GRAMMAR.test(chunk.replace(/\b[A-Z]{2,}\b/g, "")) ||
    /^\s*[A-Z][a-z].*[.?!]\s*$/.test(chunk)
  );
}

/**
 * Whether `chunk` is clearly the other language of the Thai/English pair
 * from the segment so far — another speaker answering without a pause.
 * Thai speech is full of English terms, often a chunk of their own, and those
 * must stay in the row: split off, they went to the Live translation and came
 * back translated ("terminal manager" → "ผู้จัดการท่าเรือ"). So English after
 * Thai has to be a clause, and Thai after English only counts if the English
 * has no Thai in it and is a sentence rather than the opening term of a Thai
 * one ("audit trail" + "ไม่ครบ"): it ended, or runs to 4+ words.
 */
export function switchesLanguage(segment: string, chunk: string): boolean {
  const segThai = count(segment, THAI_LETTER);
  const segLatin = count(segment, LATIN_LETTER);
  if (segThai + segLatin < 8) return false;
  const thai = count(chunk, THAI_LETTER);
  const latin = count(chunk, LATIN_LETTER);
  if (thai >= 4 && latin === 0) {
    const english = segment.trim();
    return (
      segThai === 0 &&
      (/[.?!]$/.test(english) || english.split(/\s+/).length >= 4)
    );
  }
  return thai === 0 && latin >= 4 && segThai > 0 && isEnglishClause(chunk);
}

/**
 * End of the last complete sentence in `text` after position `from`, with
 * at least MIN_SENTENCE_CHARS of text since `from`; -1 if there is none.
 * Used to correct a Live translation sentence by sentence while the speaker
 * keeps talking.
 */
export function lastSentenceEnd(text: string, from: number): number {
  let end = -1;
  LIVE_END.lastIndex = 0;
  for (let m = LIVE_END.exec(text); m; m = LIVE_END.exec(text)) {
    const e = m.index + m[0].length;
    if (e > from && text.slice(from, e).trim().length >= MIN_SENTENCE_CHARS) {
      end = e;
    }
  }
  return end;
}

/**
 * Whether `text` ends on a firm sentence end, so a short pause is enough to
 * close it (the bridge's SENTENCE_END_GAP_MS).
 */
export function endsSentence(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.length >= MIN_SENTENCE_CHARS && ENDS_SENTENCE.test(trimmed);
}

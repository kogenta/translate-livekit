/**
 * Text translation via a regular (non-Live) Gemini model — used in hybrid
 * mode for the direction that has no Live session of its own (see
 * TRANSLATION_MODE in translation-session-manager.ts).
 *
 * Measured with gemini-3.5-flash-lite + thinkingLevel "minimal" on a paid
 * key: ~1.0-1.5s per utterance (2.1s worst of 20 concurrent), ~280-370
 * input / ~10-18 output text tokens per request (refine: ~450 / ~15), no
 * thinking tokens. All text calls together cost ~11% of the Live session
 * (see the [Usage] log lines). Assumes a paid key: a free-tier key's 15 requests
 * per minute run out in a two-way conversation and translations get lost.
 */

import {
  ENGLISH_TERMS_PROMPT,
  parseTermPairs,
  swapEnglishTerms,
} from "./english-terms";
import { DOMAIN_PROMPT, NUMBER_RULE } from "./interpreter-prompt";
import { detectLanguage, getLanguageByCode } from "./languages";
import { formatTranscript } from "./text-format";
import { westernYears } from "./thai-year";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Well above a normal request (see above), so only a stuck one is cut off,
// early enough that a final translation's retry still arrives in time to
// be useful.
const TIMEOUT_MS = 4000;

export interface ContextLine {
  language: string;
  text: string;
}

function languageName(code: string): string {
  return getLanguageByCode(code)?.name ?? code;
}

/**
 * One generateContent call; returns the response text (throws on failure).
 * `label` names the call in the [Usage] log line (interim, final, refine…).
 */
async function generate(
  apiKey: string,
  model: string,
  systemText: string,
  userText: string,
  label: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: {
            temperature: 0.2,
            thinkingConfig: { thinkingLevel: "minimal" },
          },
        }),
      },
    );
    const data = await res.json();
    const usage = data?.usageMetadata;
    if (usage) {
      console.log(
        `[Usage] text ${label} ${model} in=${usage.promptTokenCount ?? 0} ` +
          `out=${usage.candidatesTokenCount ?? 0} think=${usage.thoughtsTokenCount ?? 0}`,
      );
    }
    if (!res.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
    }
    const out: string = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("")
      .trim();
    if (!out) throw new Error("empty response");
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function requestTranslation(
  apiKey: string,
  model: string,
  text: string,
  from: string,
  to: string,
  context: ContextLine[],
  partial: boolean,
): Promise<string> {
  const contextBlock = context.length
    ? "Previous conversation (context only, do not translate):\n" +
      context.map((c) => `[${languageName(c.language)}] ${c.text}`).join("\n") +
      "\n\n"
    : "";

  return generate(
    apiKey,
    model,
    DOMAIN_PROMPT +
      `\n\nTranslate the ${languageName(from)} utterance into ${languageName(to)}. ` +
      "It is a live speech transcript, so it may lack punctuation or contain " +
      "recognition slips — translate the intended meaning. " +
      (partial
        ? "The speaker is still talking, so it may stop mid-sentence — " +
          "translate only what is there, without completing it. "
        : "") +
      "Output only the translation, with no notes or quotes.",
    `${contextBlock}Translate:\n${from === "th" ? westernYears(text) : text}`,
    partial ? "interim" : "final",
  );
}

/**
 * Translate one utterance, retrying once. Returns null if every attempt
 * fails. `partial` marks an utterance still being spoken (an interim
 * translation): it is tried once, since the final translation follows anyway.
 */
export async function translateText(opts: {
  apiKey: string;
  text: string;
  from: string;
  to: string;
  context?: ContextLine[];
  partial?: boolean;
}): Promise<string | null> {
  const model = process.env.TEXT_TRANSLATE_MODEL || DEFAULT_MODEL;
  const attempts = opts.partial ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestTranslation(
        opts.apiKey,
        model,
        opts.text,
        opts.from,
        opts.to,
        opts.context ?? [],
        opts.partial ?? false,
      );
    } catch (error) {
      console.warn(
        `[TextTranslator] ${opts.from}→${opts.to} attempt ${attempt} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return null;
}

/**
 * A Thai transcript with its English words back in Latin letters (see
 * english-terms.ts), or null if nothing changed or the request failed. Text
 * that turned out mostly English is dropped too: the watch page would take it
 * for an English utterance and hide its row.
 */
export async function restoreEnglishTerms(opts: {
  apiKey: string;
  text: string;
}): Promise<string | null> {
  try {
    const out = swapEnglishTerms(
      opts.text,
      parseTermPairs(
        await generate(
          opts.apiKey,
          process.env.TEXT_TRANSLATE_MODEL || DEFAULT_MODEL,
          ENGLISH_TERMS_PROMPT,
          opts.text,
          "english-terms",
        ),
      ),
    );
    return out !== opts.text && detectLanguage(out) === "th" ? out : null;
  } catch (error) {
    console.warn(
      `[TextTranslator] English terms failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// Refine runs on its own model. On 80 real English/Live-Thai pairs
// gemini-3.1-flash-lite answered in ~1.0s and never spaced every word;
// gemini-3.5-flash-lite was slower (~1.2s) and spaced every word in 9 of 80.
const REFINE_MODEL = "gemini-3.1-flash-lite";

// The draft is changed only where it is wrong, makes no sense or doesn't fit
// together; everything else stays as the audience heard it. No DOMAIN_PROMPT
// here: its "keep English terms" rule made the model swap the draft's
// correct Thai for English ("ประตู" → "Gate", 24 of 80) and add glosses in
// brackets. Don't name example terms either ("do not write Gate", "names of
// systems"): that primed the model to do exactly that. Speakers mix Thai,
// English and English spelled in Thai, so the rule is not "write Thai" but
// "keep each word's language" — a word is never swapped into the other one.
// Measured twice on 80 real pairs plus 10 code-switched drafts: numbers all
// right, no mixed pronoun/particle, a third of the drafts left untouched, no
// brackets, every English word, code and Thai-spelled loanword of the
// code-switched drafts kept. Leftover swaps ("terminal operating system",
// ~15% of real pairs) are retried (languageSwaps).
const REFINE_PROMPT =
  "You correct the Thai subtitle of a live English-to-Thai interpretation at a corporate audit " +
  "(port operations, logistics, finance, IT). " +
  "You get what the speaker said in English (a live transcript) and the interpreter's Thai draft. " +
  "The draft was produced piece by piece while the speaker was still talking, so it may lose or " +
  "garble meaning, render phrases too literally, or switch pronoun or polite particle (ผม/ฉัน, ครับ/ค่ะ) mid-sentence.\n" +
  "Write the corrected Thai subtitle. Change the draft only where:\n" +
  "1. a word or phrase is wrong or doubtful compared with the English (including numbers), or part of the English is missing;\n" +
  "2. the sentence makes no sense or reads unnaturally;\n" +
  "3. its words don't fit together, e.g. a mixed pronoun and particle: ผม goes with ครับ, ฉัน with ค่ะ/คะ — " +
  "make them match whichever the draft uses most.\n" +
  "Everything else stays exactly as in the draft: the audience hears the draft as audio. In particular:\n" +
  "- Keep every word the draft already has in the language and spelling it uses (Thai, English, or " +
  "English spelled in Thai); never translate one of them into the other language. Write anything " +
  "you rewrite in Thai. Never add brackets.\n" +
  "- Do not add a pronoun or polite particle that the draft doesn't have.\n" +
  `- ${NUMBER_RULE}\n` +
  "- Translate only as far as the draft goes: if the English continues past the end of the draft, stop there.\n" +
  "- You may also get Thai that is already corrected: the subtitle so far, which the draft continues. Output the " +
  "whole draft, corrected, and never repeat the already-corrected Thai.\n" +
  "- Thai has no spaces between words: put a space only between sentences or clauses and around English words and numbers.\n" +
  "Output only the Thai subtitle.";

/**
 * Backstop for Thai spaced word by word: 3+ spaces between Thai letters and
 * under 10 letters per run (real clauses are longer).
 */
function spacesEveryWord(text: string): boolean {
  const spaces = (text.match(/[฀-๿] +(?=[฀-๿])/g) ?? []).length;
  const letters = (text.match(/[฀-๿]/g) ?? []).length;
  return spaces >= 3 && letters / (spaces + 1) < 10;
}

/**
 * `text` without the already-corrected Thai it starts with, if any. The
 * prompt says never to repeat it, but the model still opened with all of it
 * or its last part ("…ช่วยพาผมไปดู" twice in one row). Spaces are ignored,
 * and an overlap under 8 letters (a particle) is left alone.
 */
function withoutRepeat(text: string, corrected: string | undefined): string {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const said = squash(corrected ?? "");
  const out = squash(text);
  for (let from = 0; said.length - from >= 8; from++) {
    if (!out.startsWith(said.slice(from))) continue;
    // Skip that many non-space characters of `text`
    let left = said.length - from;
    let i = 0;
    while (left > 0 && i < text.length) if (!/\s/.test(text[i++])) left--;
    return text.slice(i).trim();
  }
  return text;
}

const englishWords = (text: string): string[] =>
  text.match(/[A-Za-z]{2,}/g) ?? [];

/**
 * Words the refined text moved into the other language: English it added
 * that the draft doesn't have (Thai turned into English; codes the speaker
 * said, in capitals, may come back, e.g. a dropped "MSKU"), and English of
 * the draft it dropped (turned into Thai). The prompt asks for neither, but
 * the model still wrote e.g. "terminal operating system" for
 * "ระบบปฏิบัติการของท่าเรือ" in ~15% of real pairs.
 */
function languageSwaps(
  text: string,
  draft: string,
  original: string,
): { added: string[]; dropped: string[] } {
  const inDraft = draft.toLowerCase();
  const inText = text.toLowerCase();
  const spoken = englishWords(original);
  return {
    added: englishWords(text).filter(
      (word) =>
        !inDraft.includes(word.toLowerCase()) &&
        !(word === word.toUpperCase() && spoken.includes(word)),
    ),
    dropped: englishWords(draft).filter(
      (word) => !inText.includes(word.toLowerCase()),
    ),
  };
}

/**
 * Correct a Live English→Thai translation against what was said. Gemini
 * Live translates piece by piece, so its Thai can lose meaning, mix
 * pronouns/particles and garble numbers, and arrives without spaces. Returns
 * the corrected, properly spaced Thai, or null on failure or an implausible
 * result (callers keep the Live text).
 *
 * `corrected` is the part of the subtitle already corrected by earlier
 * calls; the draft continues it, and only the continuation is corrected
 * and returned. That keeps each call short while the speaker goes on.
 */
export async function refineTranslation(opts: {
  apiKey: string;
  original: string;
  draft: string;
  corrected?: string;
}): Promise<string | null> {
  try {
    const request =
      `English: ${opts.original}\n` +
      (opts.corrected ? `Thai already corrected: ${opts.corrected}\n` : "") +
      `Thai draft: ${opts.draft}`;
    const ask = async (text: string, label: string) =>
      withoutRepeat(
        formatTranscript(
          await generate(opts.apiKey, REFINE_MODEL, REFINE_PROMPT, text, label),
        ),
        opts.corrected,
      );
    let out = await ask(request, "refine");
    // A word moved into the other language: ask once more, naming the words.
    // Rejecting instead would also throw away the fix, and the swap is often
    // how the model fixed a real mistake ("อาคารผู้โดยสาร" for "terminal
    // operating system"). Every retry in testing came back right.
    const swaps = languageSwaps(out, opts.draft, opts.original);
    if (swaps.added.length || swaps.dropped.length) {
      // Name the words, and point back at the draft's own words: told only
      // "not gate", the model once picked a wrong Thai word instead.
      const notes = [
        swaps.added.length &&
          `do not use the English words ${swaps.added.join(", ")}; write those ` +
            "parts in Thai, using the draft's own words where they were right",
        swaps.dropped.length &&
          `keep the English words ${swaps.dropped.join(", ")} as they are`,
      ].filter(Boolean);
      out = await ask(
        `${request}\nKeep each word in the language the draft uses: ${notes.join("; ")}.`,
        "refine-retry",
      );
    }
    // Still swapped, word-by-word spacing, or far longer than the draft:
    // the model translating past the draft (it finishes a sentence the
    // draft stops in, which then repeats when the rest of the draft is
    // corrected), or explaining instead of answering
    const left = languageSwaps(out, opts.draft, opts.original);
    if (
      left.added.length ||
      left.dropped.length ||
      spacesEveryWord(out) ||
      out.length > opts.draft.length * 1.5 + 10
    ) {
      console.warn(
        `[TextTranslator] Refine result rejected — keeping the Live text:`,
        out.slice(0, 80),
      );
      return null;
    }
    return out;
  } catch (error) {
    console.warn(
      `[TextTranslator] Refine failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Display formatting for live transcripts. Gemini's transcription chunks
 * are concatenated as they arrive, so Thai in particular comes out with no
 * space after punctuation, sentences run together ("ดังนั้น,ฟังดูดีนะ") and
 * English terms glued to Thai ("ระบบAIใหม่"). These rules only insert or
 * swap spacing and punctuation — never words — and are stable as text
 * grows, so the live highlight in the watch page keeps working.
 *
 * Pure TypeScript, shared by the server and the watch page.
 */

const THAI = "฀-๿";
const LATIN_OR_DIGIT = "A-Za-z0-9";

const rules: [RegExp, string][] = [
  // A number split across transcription chunks is joined back: "14," +
  // " 300", or "14,3" + " 00" (digits on both sides of the space that make
  // up exactly one three-digit group)
  [/(\d),\s+(?=\d{3}(?!\d))/g, "$1,"],
  [/(\d),(\d)\s+(\d\d)(?!\d)/g, "$1,$2$3"],
  [/(\d),(\d\d)\s+(\d)(?!\d)/g, "$1,$2$3"],
  // No space between a number and a percent sign ("2.5 %")
  [/(\d)\s+%/g, "$1%"],
  // Thai doesn't use commas or full stops: between Thai text they're a pause,
  // written as a space ("ดังนั้น,ฟัง" → "ดังนั้น ฟัง")
  [new RegExp(`([${THAI}])\\s*[,.]\\s*(?=[${THAI}])`, "g"), "$1 "],
  // ครับ/ค่ะ end a sentence; one directly followed by more Thai gets a space
  // (see sentence-boundary.ts — "ครับผม" is a single particle)
  [new RegExp(`(ครับ(?!ผม)|ค่ะ)(?=[${THAI}])`, "g"), "$1 "],
  // Space after ? ! ; : and commas when a word follows. Digits are left
  // alone ("10:30", "1,000").
  [/([?!;:,])(?=[\p{L}])/gu, "$1 "],
  // Full stop between sentences ("plan.We" → "plan. We"), but not inside
  // abbreviations ("U.S.A") or numbers ("3.5")
  [/([a-z฀-๿]{2})\.(?=[A-Z฀-๿])/gu, "$1. "],
  // Thai convention: a space around embedded English words and numbers
  [new RegExp(`([${THAI}])(?=[${LATIN_OR_DIGIT}])`, "g"), "$1 "],
  [new RegExp(`([${LATIN_OR_DIGIT}])(?=[${THAI}])`, "g"), "$1 "],
  // No space before closing punctuation, and single spaces only
  [/[ \t]+([?!;:,.)])/g, "$1"],
  [/[ \t]{2,}/g, " "],
];

/** Fix spacing and punctuation of a live transcript for display. */
export function formatTranscript(text: string): string {
  let out = text;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out.trim();
}

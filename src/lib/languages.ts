export interface Language {
  code: string;
  name: string;
  /** Name in the language itself — used for split-view column headers. */
  nativeName: string;
  flag: string;
  /** Characters that identify text as this language (global, for counting). */
  script: RegExp;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: "th", name: "Thai", nativeName: "ไทย", flag: "🇹🇭", script: /[\u0E00-\u0E7F]/g },
  {
    code: "en",
    name: "English",
    nativeName: "English",
    flag: "🇺🇸",
    script: /[A-Za-z]/g,
  },
  // { code: "ja", name: "Japanese", nativeName: "日本語", flag: "🇯🇵", script: /[\u3040-\u30FF\u4E00-\u9FFF]/g },
];

/** Default split-screen pair: [left, right]. */
export const DEFAULT_PAIR: [string, string] = ["th", "en"];

export function getLanguageByCode(code: string): Language | undefined {
  return SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
}

/**
 * Whether `code` is in SUPPORTED_LANGUAGES. The only languages this deployment
 * translates: every API route and the session manager reject anything else, so
 * a stale client or a hand-written request can't open a Gemini session for a
 * language that is switched off (e.g. "ja"). Enable a language by adding it to
 * SUPPORTED_LANGUAGES.
 */
export function isSupportedLanguage(code: unknown): code is string {
  return typeof code === "string" && getLanguageByCode(code) !== undefined;
}

/**
 * Detect which supported language `text` is written in by counting script
 * characters. Majority wins, except that a quarter Thai makes it Thai: English
 * terms have more letters than the Thai around them ("ตอนนี้ vessel schedule กับ
 * berth plan ยังไม่ตรงกัน"), and counted as English such a sentence went to the Live
 * translation, which translated those terms. Text from an English speaker
 * hardly ever has Thai in it. Returns null until there's enough text to tell.
 */
export function detectLanguage(text: string, minChars = 2): string | null {
  let best: string | null = null;
  let bestCount = 0;
  let thai = 0;
  for (const lang of SUPPORTED_LANGUAGES) {
    const count = text.match(lang.script)?.length ?? 0;
    if (lang.code === "th") thai = count;
    if (count > bestCount) {
      best = lang.code;
      bestCount = count;
    }
  }
  if (best === "en" && thai >= minChars && thai * 3 >= bestCount) return "th";
  return bestCount >= minChars ? best : null;
}

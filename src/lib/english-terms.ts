/**
 * Puts English words of Thai speech back in Latin letters. Gemini Live's
 * transcription spells some of them in Thai ("คอนโทรล", "เรตติ้ง"), mostly the
 * words Thai staff use every day. Nothing on the Live side changes that: on
 * Thai-accent test clips it wrote 25 of 30 words in Latin letters with the
 * default setup, and the same with languageCodes, customVocabulary or a
 * transcription rule in the system prompt (both settings together even turned
 * "finding" into "riding").
 *
 * So a text model names those words once the segment ends (restoreEnglishTerms
 * in text-translator.ts). It only names them and code does the swap, because
 * this text may be audit evidence: the rest of it cannot change.
 *
 * Pure TypeScript, no I/O.
 */

// The examples can't prime a wrong result, since a pair only counts if its Thai
// is in the transcript. Without them the model called words like เช็ก and รีวิว
// Thai and left them (found 215 of 245 words, against 363 of 385 with them).
export const ENGLISH_TERMS_PROMPT =
  "You check a speech-to-text transcript of Thai speech at a company. Thai staff often say English words in Thai sentences, " +
  "and the recognizer sometimes spells such a word in Thai letters. List every English word or phrase that was spelled in Thai letters, with its English spelling.\n" +
  "- Copy the Thai exactly as it appears in the transcript, only that word or phrase.\n" +
  "- List it only if the Thai letters sound out the English word. Never translate: a real Thai word that means the same is not listed, however common the English term is.\n" +
  "- Include words used so much at work that Thai people treat them as Thai and normally write them in Thai letters (เช็ก => check, รีวิว => review, เคลียร์ => clear, ทีม => team, เรตติ้ง => rating), and letter names of abbreviations (ไอที => IT).\n" +
  "- Leave out Thai words, Thai names of people and places, Thai slang, numbers, and anything already in Latin letters. Also leave out loanwords of everyday life outside work (โอเค, เปอร์เซ็นต์, ลิฟต์).\n" +
  "- The transcript may have recognition slips, so a spelling may be a little off; use the English word it sounds like.\n" +
  "Output one per line as `thai => english`, or only NONE if there are none. No other text.";

/** The `thai => english` pairs in a model response; other lines are ignored. */
export function parseTermPairs(raw: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(
      /^\s*[`"']?([฀-๿][฀-๿ ]*?)[`"']?\s*=>\s*[`"']?([A-Za-z][A-Za-z0-9 ./&-]*?)[`"']?\s*$/,
    );
    if (match) pairs.push([match[1], match[2]]);
  }
  return pairs;
}

// Thai consonants that English words spelled in Thai practically never use, so
// a word with one of them is a Thai word ("สิทธิ์" came back as "site").
const THAI_ONLY_LETTERS = /[ขฃฅฆฉฌญฎฏฐฑฒณถธผฝภฬษ]/;

// The English letters each remaining Thai consonant can stand for
const SOUNDS: Record<string, string> = {
  ก: "gkcqx",
  ค: "kcqgx",
  ง: "ng",
  จ: "jgcd",
  ช: "csjt",
  ซ: "szcxt",
  ด: "dt",
  ต: "td",
  ท: "td",
  น: "n",
  บ: "bp",
  ป: "pb",
  พ: "pb",
  ฟ: "fvp",
  ม: "m",
  ย: "yiu",
  ร: "r",
  ล: "l",
  ว: "wvu",
  ศ: "sc",
  ส: "szcxt",
  ห: "h",
  ฮ: "h",
};

// What an abbreviation's first letter is called, to check "ไอที" against "IT"
const LETTER_NAMES: Record<string, string> = {
  A: "เอ",
  B: "บี",
  C: "ซี",
  D: "ดี",
  E: "อี",
  F: "เอฟ",
  G: "จี",
  H: "เอช",
  I: "ไอ",
  J: "เจ",
  K: "เค",
  L: "แอล",
  M: "เอ็ม",
  N: "เอ็น",
  O: "โอ",
  P: "พี",
  Q: "คิว",
  R: "อาร์",
  S: "เอส",
  T: "ที",
  U: "ยู",
  V: "วี",
  W: "ดับเบิลยู",
  X: "เอ็กซ์",
  Y: "วาย",
  Z: "แซด",
};

/**
 * Whether the Thai sounds out the English: most of its consonants must line up
 * with the English letters, in order. Stops a translation in place of a
 * spelling ("ฝ่ายไอที" came back as "department IT" in 2 of 5 runs). A check of
 * sounds alone can't catch every one, but a miss only leaves the Thai spelling.
 */
export function soundsLikeEnglish(thai: string, english: string): boolean {
  if (THAI_ONLY_LETTERS.test(thai)) return false;
  if (/^[A-Z0-9/-]+$/.test(english)) {
    return thai.startsWith(LETTER_NAMES[english[0]] ?? "\0");
  }
  // ์ silences its consonant, with any vowel mark between them
  const consonants = [...thai.replace(/[ก-ฮ][ิุ]?์/g, "")].filter(
    (ch) => SOUNDS[ch],
  );
  const letters = english.toLowerCase().replace(/[^a-z]/g, "");
  if (!consonants.length) return letters.length > 0;
  // Longest common subsequence of consonants and letters
  let previous = new Array<number>(letters.length + 1).fill(0);
  for (const consonant of consonants) {
    const row = [0];
    for (let j = 1; j <= letters.length; j++) {
      row[j] = SOUNDS[consonant].includes(letters[j - 1])
        ? previous[j - 1] + 1
        : Math.max(previous[j], row[j - 1]);
    }
    previous = row;
  }
  return previous[letters.length] / consonants.length > 0.6;
}

/**
 * `text` with each pair's Thai swapped for its English, longest first so that
 * a word inside a longer one doesn't split it. Spaces go around each swapped
 * word, since neighbouring words would otherwise run together.
 */
export function swapEnglishTerms(
  text: string,
  pairs: [string, string][],
): string {
  let out = text;
  for (const [thai, english] of [...pairs].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (soundsLikeEnglish(thai, english)) {
      out = out.split(thai).join(` ${english} `);
    }
  }
  return out === text ? text : out.replace(/ {2,}/g, " ").trim();
}

/**
 * Thai Buddhist years to Western years, done in code because the text model
 * gets the subtraction wrong: a sentence with two years ("ปี2568…ส่วนปี2567")
 * came out with "2027" in 4 of 10 runs, even with the rule and worked examples
 * in DOMAIN_PROMPT. Only a number with a year word, month or date before it
 * counts, so a quantity or an ID ("ตู้ 2567 ใบ") stays as it is.
 *
 * Pure TypeScript, no I/O.
 */

const MONTH =
  "มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม" +
  "|ม\\.ค\\.|ก\\.พ\\.|มี\\.ค\\.|เม\\.ย\\.|พ\\.ค\\.|มิ\\.ย\\.|ก\\.ค\\.|ส\\.ค\\.|ก\\.ย\\.|ต\\.ค\\.|พ\\.ย\\.|ธ\\.ค\\.";
const ERA = "พ\\.?\\s?ศ\\.?";
const LEAD =
  `ปี(?:งบประมาณ|งบ|บัญชี|การเงิน|ภาษี)?\\s*(?:${ERA})?|${ERA}|FY|${MONTH}` +
  "|\\d{1,2}[/-]\\d{1,2}[/-]";
const YEAR = "2[45]\\d{2}(?!\\d)";
const YEARS = new RegExp(
  `(${LEAD})(\\s*)(${YEAR})((?:\\s*(?:-|–|ถึง|และ|กับ|หรือ|,)\\s*${YEAR})*)`,
  "g",
);

const western = (year: string) => String(Number(year) - 543);

/**
 * `text` with its Buddhist years written as Western years ("ปี2567" → "ปี2024",
 * "พ.ศ. 2562" → "ค.ศ. 2019"). A bare year joined to one of them counts too
 * ("ปี 2566-2567") if it is close enough to be a year at all, which "ปี 2568
 * กับ 2500 ตู้" is not.
 */
export function westernYears(text: string): string {
  return text.replace(
    YEARS,
    (_, lead: string, space: string, year: string, more: string) =>
      lead.replace(new RegExp(ERA), "ค.ศ.") +
      space +
      western(year) +
      more.replace(/2[45]\d{2}/g, (y) =>
        Math.abs(Number(y) - Number(year)) <= 20 ? western(y) : y,
      ),
  );
}

/**
 * Domain instructions shared by every translation path — the Gemini Live
 * session's systemInstruction and the text translator used in hybrid mode —
 * so both directions use the same terminology and tone.
 *
 * Edit this to retarget the deployment (industry, glossary, tone).
 */

/**
 * How every path renders numbers — audits turn on figures, and digits are
 * what a reader checks fastest. Also part of the Live-translation refine
 * prompt (text-translator.ts). The ID clause matters: without it a model
 * writes "MSKU 4071229" as "MSKU 4,071,229".
 */
export const NUMBER_RULE =
  "Numbers must match the speaker exactly, never dropped, rounded or changed. " +
  "Write every amount, quantity, percentage, date and time as digits, with " +
  "thousands separators for amounts and quantities (eight hundred thousand / " +
  "แปดแสน → 800,000), keeping its unit or currency and words like about/ประมาณ. " +
  "Write IDs, codes and phone numbers as plain digits with no separators.";

/**
 * Added to NUMBER_RULE in DOMAIN_PROMPT only, so the refine prompt stays as
 * measured; refine only goes into Thai, where a year stays as said.
 * Small numbers: without the examples this longer prompt got "three months"
 * in 8 of 10 runs. Years: the text model wrote ปี 2567 as "2027" and ปี 67 as
 * "2067". Told to keep the Buddhist year, it mixed calendars in one sentence
 * ("January 2024 to March B.E. 2568"). Listing only the results (2567 = 2024)
 * still gave "2027" in 7 of 30 runs of its worst sentence ("…ปี 2568 ยังไม่ได้ปิด
 * ส่วนปี 2567 ปิดแล้ว"); writing out the subtraction, 1 of 30.
 * Written as Live transcribes it, with no spaces ("ปี2568…ส่วนปี2567"), that
 * sentence still gave "2027" in 4 of 10, so the text path converts in code first
 * (thai-year.ts). This rule remains for what that misses and for Live into
 * English, which gets audio. ปี67 is left to it: right 10 of 10.
 */
const NUMBER_DETAILS =
  "That includes small counts and durations (สามเดือน → 3 months, ห้าปี → 5 years). " +
  "Exception for years: into English, a Thai Buddhist year becomes the Western " +
  "year by subtracting 543 (2566 - 543 = 2023, 2567 - 543 = 2024, 2568 - 543 = 2025, " +
  "2569 - 543 = 2026; ปี 67 is 2567); into Thai, a year stays as said.";

// The wording here is measured: repeat a change 10 times per sentence, since
// these slips appear in only some runs and 2-3 runs missed them.
// - No modal words in the certainty rule: "ควร = should, ต้อง = must" turned
//   ควร into "must" (up to 10 of 10 on one sentence).
// - Hedges are named: without "I think/ผมคิดว่า" the filler rule dropped them.
// - The number rule comes last: mid-prompt, digits slipped more often.
// - The glossary holds only terms the model otherwise gets wrong or varies
//   ("authority matrix", "Finance" for ฝ่ายบัญชี, "gantry crane" for เครนหน้าท่า),
//   because each entry primes: with รถหัวลาก listed, พนักงานขับรถ became "terminal
//   tractor driver", and with only ท่าเทียบเรือ, ท่าเรือ became "Terminal". Hence
//   "only for exactly these words" and the ท่าเรือ entry. Container-only terms
//   are left out, since LRT is not a container terminal.
// - Live mostly follows the glossary and the name rule but not the filler
//   rule, and this length didn't slow it. Refine leaves this prompt out on
//   purpose (see REFINE_PROMPT in text-translator.ts), so it won't restore a
//   glossary term that Live missed.
// Known gap: a spoken request to translate a glossary word gets answered
// ("ค่าเสียเวลาเรือ") instead of translated; other words are fine.
const domainPrompt = (task: string): string =>
  [
    "You are an expert real-time simultaneous interpreter at an internal audit of Laemchabang International Ro-Ro Terminal Limited (LRT), the operator of Terminal C0 at Laem Chabang Port, Chonburi, Thailand. LRT handles ocean-going vessels: Ro-Ro, general cargo, military and passenger ships. Internal auditors interview staff and review documents and systems across operations, logistics, accounting, finance, procurement and IT.",
    `${task} What is said may become audit evidence, so accuracy comes before style.`,
    "- Translate everything said and add nothing; never summarize, explain or answer. A question or request is translated as a question or request, never carried out.",
    "- Keep how certain and how binding each statement is: advice stays advice, a requirement stays a requirement, a guess stays a guess. Keep negatives, conditions and hedges such as I think/ผมคิดว่า. Never make a statement softer or stronger.",
    "- Thai often omits the subject. Take it from the conversation when that is clear; otherwise use a neutral form such as the passive. Never invent who did something.",
    "- Write พี่/น้อง/คุณ + name as the name alone, never with Phi, Nong or Mr./Ms. พี่/น้อง with no name means you or the colleague, never a relative or a name.",
    "- Drop fillers and false starts (เอ่อ, um, a repeated word).",
    "- The transcript may contain recognition slips and English words spelled in Thai: choose the reading that makes sense at a port company's audit.",
    "- Keep acronyms and codes as spoken (LRT, NYK, A1, A5, C0, Ro-Ro, B/L, D/O, CY, CFS, THC, TOS, PO, PR, GR, SOP, KPI, ISO, ISPS). A word the speaker says in English stays in English, in Latin letters, even inside a Thai sentence. In Thai output, audit, port and IT terms that Thai staff normally say in English stay in English.",
    "- Thai output uses one polite form, never alternatives such as ครับ/ค่ะ.",
    "- Use these terms only for exactly these words: แอลอาร์ที = LRT; ซีศูนย์ = C0; ท่าเรือแหลมฉบัง = Laem Chabang Port; เรือโรโร = Ro-Ro vessel; ขับขึ้น-ลง = roll-on/roll-off; เรือสินค้าทั่วไป = general cargo vessel; เรือทางการทหาร = military vessel; เรือโดยสาร = passenger vessel; เรือเดินทะเล = ocean-going vessel; ฝ่ายบัญชี = accounting department; ฝ่ายการเงิน = finance department; ข้อตรวจพบ = finding; กระดาษทำการ = working papers; อำนาจดำเนินการ = delegation of authority; กระทบยอด = reconcile; ท่าเรือ = port; ท่าเทียบเรือ = terminal; เครนหน้าท่า = quay crane; สายเรือ = shipping line; ค่าภาระหน้าท่า = terminal handling charge; ค่าเสียเวลาเรือ = demurrage; ค่าธรรมเนียมเรือเข้าท่า = port dues.",
    "- Keep the tone formal, polite and neutral.",
    `- ${NUMBER_RULE} ${NUMBER_DETAILS}`,
  ].join("\n");

export const DOMAIN_PROMPT = domainPrompt(
  "Your task is to translate speech between Thai and English instantly and accurately.",
);

/**
 * DOMAIN_PROMPT for a Live session, which translates one way. Told "between
 * Thai and English", it ignored echoTargetLanguage: false and spoke over every
 * Thai speaker on the Thai voice (8 of 8 clips), sometimes in English. Naming
 * one direction left 7 of 8 silent and English speech translated as before.
 */
export const liveDomainPrompt = (from: string, to: string): string =>
  domainPrompt(
    `Your task is to translate ${from} speech into ${to} instantly and accurately. ` +
      `When the speech is already in ${to}, stay silent: say nothing and output nothing.`,
  );

import type { IRunOptions, TextRun as TextRunType } from "docx";
import { getLanguageByCode } from "@/lib/languages";
import type { Cell, LanguagePair, Row } from "./SplitTranscript";

/** Everything a transcript file is made from. */
export interface TranscriptExport {
  sessionId: string;
  pair: LanguagePair;
  /** Time of the first utterance (bridge clock); null before anyone spoke. */
  startedAt: number | null;
  /** The rows the watch page shows (buildRows), for the whole session. */
  rows: Row[];
}

export type ExportFormat = "txt" | "docx";

const TITLE = "Live Interpreter transcript";

// Word colors, matching the page: originals secondary, translations primary
const ORIGINAL_COLOR = "5B6472";
const CAPTION_COLOR = "98A2B3";
const HEAD_FILL = "EAF1FA";

// Word draws Thai in Angsana New, which is small and hard to read, unless
// the run names a Thai font in every slot: a `cs` font alone, the document
// defaults and the theme's Thai font were all ignored in testing. So Thai
// text gets runs of its own. Tahoma has Thai on Windows and macOS.
const LATIN_FONT = "Calibri";
const THAI_FONT = "Tahoma";
// Tahoma's Thai looks larger than Calibri at the same size
const THAI_SCALE = 0.9;
// Half-points: 11 pt body text
const BASE_SIZE = 22;
// Thai words and the spaces between them; the split keeps the matches
const THAI_RUN = /([\u0E00-\u0E7F]+(?:\s+[\u0E00-\u0E7F]+)*)/;

// Table widths in twips; 9000 fits A4 and Letter with 1-inch margins
const TIME_WIDTH = 1000;
const TEXT_WIDTH = 4000;

function languageName(code: string): string {
  return getLanguageByCode(code)?.name ?? code;
}

function metaLines(t: TranscriptExport): string[] {
  return [
    `Session: ${t.sessionId}`,
    ...(t.startedAt !== null
      ? [`Started: ${new Date(t.startedAt).toLocaleString()}`]
      : []),
    // Not ⇄: Calibri has no glyph for it
    `Languages: ${languageName(t.pair[0])} – ${languageName(t.pair[1])}`,
  ];
}

interface Line {
  lang: string;
  text: string;
  original: boolean;
}

/** A row's text as labeled lines, the original before its translation. */
function rowLines(row: Row, pair: LanguagePair): Line[] {
  const lines: Line[] = [];
  row.cells.forEach((cell, side) => {
    if (!cell) return;
    if (cell.caption) {
      lines.push({ lang: cell.caption.lang, text: cell.caption.text, original: true });
    }
    if (cell.text) {
      lines.push({ lang: pair[side], text: cell.text, original: cell.role === "original" });
    }
  });
  // Stable sort: keeps the column order within each kind
  return lines.sort((a, b) => Number(b.original) - Number(a.original));
}

function toPlainText(t: TranscriptExport): Blob {
  const out = [TITLE, ...metaLines(t), ""];
  for (const row of t.rows) {
    out.push(`[${row.time}]`);
    for (const line of rowLines(row, t.pair)) {
      out.push(`${line.lang.toUpperCase()}  ${line.text}`);
    }
    out.push("");
  }
  // BOM + CRLF so Notepad and Word on Windows open the Thai text as UTF-8
  return new Blob(["\uFEFF" + out.join("\r\n")], { type: "text/plain;charset=utf-8" });
}

/**
 * A Word document laid out like the screen: a time column, then one column
 * per language. docx is imported on demand, so the watch page doesn't load
 * it until someone downloads a Word file.
 */
async function toWord(t: TranscriptExport): Promise<Blob> {
  const {
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx");

  // `text` as runs with `options`, the Thai parts in the Thai font
  const runs = (text: string, options: IRunOptions = {}): TextRunType[] =>
    text
      .split(THAI_RUN)
      .map((part, i) =>
        !part
          ? null
          : i % 2
            ? new TextRun({
                ...options,
                text: part,
                font: THAI_FONT,
                size: Math.round((Number(options.size) || BASE_SIZE) * THAI_SCALE),
              })
            : new TextRun({ ...options, text: part })
      )
      .filter((r): r is TextRunType => r !== null);

  const cell = (children: InstanceType<typeof Paragraph>[], width: number, head = false) =>
    new TableCell({
      children,
      width: { size: width, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: HEAD_FILL } : undefined,
    });

  const textCell = (c: Cell | null) => {
    const paragraphs: InstanceType<typeof Paragraph>[] = [];
    if (c?.caption) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${c.caption.lang.toUpperCase()}  `, bold: true, size: 16, color: CAPTION_COLOR }),
            ...runs(c.caption.text, { size: 18, color: CAPTION_COLOR }),
          ],
        })
      );
    }
    if (c?.text) {
      paragraphs.push(
        new Paragraph({
          children: runs(c.text, {
            color: c.role === "original" ? ORIGINAL_COLOR : undefined,
          }),
        })
      );
    }
    // A cell needs at least one paragraph
    return cell(paragraphs.length ? paragraphs : [new Paragraph("")], TEXT_WIDTH);
  };

  const headRow = new TableRow({
    tableHeader: true, // repeated at the top of every page
    children: [
      cell([new Paragraph({ children: [new TextRun({ text: "Time", bold: true })] })], TIME_WIDTH, true),
      ...t.pair.map((code) =>
        cell(
          [new Paragraph({ children: [new TextRun({ text: languageName(code), bold: true })] })],
          TEXT_WIDTH,
          true
        )
      ),
    ],
  });

  const bodyRows = t.rows.map(
    (row) =>
      new TableRow({
        cantSplit: true,
        children: [
          cell(
            [new Paragraph({ children: [new TextRun({ text: row.time, size: 18, color: CAPTION_COLOR })] })],
            TIME_WIDTH
          ),
          textCell(row.cells[0]),
          textCell(row.cells[1]),
        ],
      })
  );

  const doc = new Document({
    title: `${TITLE} — ${t.sessionId}`,
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: LATIN_FONT, hAnsi: LATIN_FONT },
            size: BASE_SIZE,
          },
        },
      },
    },
    sections: [
      {
        children: [
          new Paragraph({ text: TITLE, heading: HeadingLevel.HEADING_1 }),
          ...metaLines(t).map(
            (line) =>
              new Paragraph({ children: runs(line, { color: ORIGINAL_COLOR }) })
          ),
          new Paragraph(""),
          new Table({
            columnWidths: [TIME_WIDTH, TEXT_WIDTH, TEXT_WIDTH],
            width: { size: TIME_WIDTH + 2 * TEXT_WIDTH, type: WidthType.DXA },
            rows: [headRow, ...bodyRows],
          }),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}

/** `transcript-{session}-{yyyy-mm-dd-hhmm}.{ext}`, in local time. */
function fileName(sessionId: string, format: ExportFormat): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}`;
  return `transcript-${sessionId}-${stamp}.${format}`;
}

/** Build the transcript file and hand it to the browser as a download. */
export async function downloadTranscript(
  t: TranscriptExport,
  format: ExportFormat
): Promise<void> {
  const blob = format === "txt" ? toPlainText(t) : await toWord(t);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(t.sessionId, format);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

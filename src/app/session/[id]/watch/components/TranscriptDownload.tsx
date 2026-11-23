"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "./icons";
import {
  downloadTranscript,
  type ExportFormat,
  type TranscriptExport,
} from "./transcript-export";

const FORMATS: { format: ExportFormat; label: string; ext: string }[] = [
  { format: "txt", label: "Text", ext: ".txt" },
  { format: "docx", label: "Word", ext: ".docx" },
];

interface TranscriptDownloadProps {
  /** Called on click, so the file has everything said up to that moment. */
  getExport: () => TranscriptExport;
  disabled: boolean;
}

/** Header button: download the session's subtitles as a text or Word file. */
export default function TranscriptDownload({ getExport, disabled }: TranscriptDownloadProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on a click outside or Esc
  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleDownload = async (format: ExportFormat) => {
    setBusy(true);
    setError(false);
    try {
      await downloadTranscript(getExport(), format);
      setOpen(false);
    } catch (err) {
      console.error("[Transcript] Download failed:", err);
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => {
          setError(false);
          setOpen((o) => !o);
        }}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Download transcript"
        title={disabled ? "Nothing to download yet" : "Download transcript"}
      >
        <DownloadIcon />
      </button>
      {open && (
        <div className="menu" aria-label="Download transcript as">
          <p className="menu-title">Download transcript</p>
          {FORMATS.map((f) => (
            <button
              key={f.format}
              type="button"
              className="menu-item"
              onClick={() => handleDownload(f.format)}
              disabled={busy}
            >
              {f.label}
              <span className="menu-hint">{f.ext}</span>
            </button>
          ))}
          {error && <p className="menu-error">Couldn&apos;t create the file. Try again.</p>}
        </div>
      )}
    </div>
  );
}

"use client";

import { SpeakerIcon } from "./icons";

/** "off", "original" (organizer's own voice), or a translator language code. */
export type AudioChoice = string;

interface AudioSelectorProps {
  value: AudioChoice;
  languages: string[];
  onChange: (value: AudioChoice) => void;
}

/**
 * Which voice to hear. Subtitles work with audio off — the default, since in
 * a face-to-face meeting everyone already hears the speaker in the room.
 */
export default function AudioSelector({ value, languages, onChange }: AudioSelectorProps) {
  const options = [
    { value: "off", label: "Off" },
    { value: "original", label: "Orig" },
    ...languages.map((code) => ({ value: code, label: code.toUpperCase() })),
  ];

  return (
    <div className="seg" role="radiogroup" aria-label="Audio">
      <span className="seg-icon">
        <SpeakerIcon muted={value === "off"} />
      </span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`seg-btn${value === o.value ? " active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

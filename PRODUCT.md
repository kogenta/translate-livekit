# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Organizers run a live broadcast (speak into a mic, share a QR code) and operators keep an eye on running sessions. Attendees open the watch page on phones or a room display. Client context (from project notes, not re-confirmed): internal audit at LRT, Laemchabang International Ro-Ro Terminal, Terminal C0, Thai and English speakers.

## Product Purpose

Real-time spoken-language translation for live broadcasts. An organizer's audio enters a LiveKit room, a server bot streams it to the Gemini Live API, and attendees read (and optionally hear) a two-way Thai/English interpretation.

## Positioning

Translation starts on demand per session and language: one Gemini session per language per room, torn down when its last listener leaves. Audio only, no video.

## Operating Context

The server keeps sessions in memory (single process). The index page is the entry point: create a session, or see which sessions are running and jump into one. `/admin` already lists sessions, bridges and LiveKit rooms with destructive controls and has no auth.

## Capabilities and Constraints

- Session = LiveKit room with the same short ID. Per session: organizer, translator bridges (`translator-{lang}`), attendees.
- Bridge status: starting, active, error, closed. Hybrid mode: one voice language per session, the other language served as text.
- Index data comes from `GET /api/sessions` and `GET /api/rooms`; the second needs a reachable LiveKit server.

## Brand Commitments

Existing look in code is kept for now: white ground, blue accent, Instrument Serif display, DM Sans body, DM Mono data.

## Product Principles

- The organizer should reach a running room in one click.
- State is stated in words, not colour alone.
- Cost-bearing things (Gemini sessions, listeners) are visible at a glance.

## Open decisions

- Whether `/admin` folds into the index (user chose dashboard-first without merging).
- Auth for index and admin (none today; demo only).

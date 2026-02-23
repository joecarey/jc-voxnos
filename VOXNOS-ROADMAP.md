# Voxnos Roadmap

Voxnos is a composable voice application platform. It provides the telephony infrastructure, TTS pipeline, and conversational turn-cycle engine — apps declare what they do at each conversational moment.

This document captures the architectural vision and phased roadmap for evolving the platform from its current single-app state toward a modular, multi-app engine.

---

## Vision

Today, Voxnos runs one app (Ava) with all conversational logic — Claude integration, history management, streaming, sentence extraction — baked into the app itself. The platform layer (routes, TTS, KV orchestration, FreeClimb integration) is already cleanly separated, but the app layer is monolithic.

The goal: any voice application — an AI assistant, an IVR, a survey, a notification line, an intake form — should be buildable by assembling shared conversational building blocks and declaring a processing strategy. The platform handles everything else.

---

## The Conversational Turn Cycle

Every voice call, regardless of use case, follows the same cycle. Each stage is a configurable behavior:

| Stage | What happens | Example (Ava) | Example (Survey) | Example (Notification) |
|---|---|---|---|---|
| **Greeting** | Call arrives, app speaks first | Random informal phrase | "This survey takes 2 minutes" | "This is a reminder about your appointment" |
| **Response** | App produces speech output | Claude-generated, streamed | Read next question from script | Pre-recorded message |
| **Listen** | App collects caller input | Open speech, 25s max | Speech or DTMF | Optional ("press 1 to repeat") |
| **Process** | App decides what to do next | Claude + tools | Advance question index, store answer | Minimal — confirm or repeat |
| **Filler** | Processing takes time, fill the silence | "On it.", "One sec." | Not needed (instant) | Not needed |
| **Re-prompt** | No input detected | "I'm still here" | "On a scale of 1 to 5..." | "Press 1 to hear again, or hang up" |
| **Closing** | Call ending | Random goodbye phrase | "Thanks for your feedback" | "Goodbye" |
| **Error** | Something goes wrong | "Let me try that again" | "Let's move to the next question" | Retry or hang up |

The **conversation engine** manages the cycle. Apps configure each stage.

---

## Building Blocks

These are the composable conversation elements. Each is independent, configurable per-app, and handled by the engine.

### Already built (in use by Ava)
- **Greeting** — phrase list, random selection, cached TTS
- **Closing** — phrase list, random selection, cached TTS, Pause + Hangup
- **Filler** — phrase list, cached TTS, probabilistic (50% coin flip), skip-if-app-yielded
- **Re-prompt** — implicit today (FreeClimb returns "I didn't quite hear that" on no-input); should be app-configurable
- **Streaming response** — sentence-by-sentence TTS via KV, /continue polling, pending/done/hangup markers
- **Tool execution** — registry-based, timeout-wrapped, result compression

### Extracted (Phase 1-3)
- **Claude integration** — `claude-client.ts`: API calls, retry logic, SSE parsing, tool-use loop
- **Conversation history** — `conversation.ts`: KV get/save, compression, TTL management
- **Sentence extraction** — `speech-utils.ts`: buffer and yield complete sentences from a text stream
- **Goodbye detection** — `speech-utils.ts`: `isGoodbye()` single source of truth (used by engine and apps)
- **Turn-cycle orchestration** — `engine.ts`: `processTurn()` returns platform-neutral `TurnResult`
- **TTS infrastructure** — `tts/helpers.ts`, `tts/streaming.ts`: voice slug, caching, streaming pipeline

### Not yet built
- **DTMF collection** — "press 1 for X" input handling
- **Confirmation** — "Did you say March 15th?" verification loop
- **Transfer** — hand off to a human agent or another number
- **Slot filling** — collect structured fields with validation
- **Classification** — intent detection for routing (could be Claude with constrained output)

---

## Processing Strategies

The "Process" stage is where apps diverge most. The engine should support pluggable processing strategies:

| Strategy | How it works | Use cases |
|---|---|---|
| **LLM conversational** | Claude with tools, full conversation history, streaming | Assistants, concierge, support agents |
| **LLM single-shot** | Claude with constrained output, no history needed | Intent classification, slot extraction, routing |
| **Scripted** | State machine or ordered question list, no LLM | Surveys, intake forms, announcements |
| **Lookup** | Call an API or database, read back results | Order status, account balance, appointment info |
| **Hybrid** | Scripted flow with LLM fallback for edge cases | Intake with natural language parsing, IVR with "just tell me what you need" |

Ava currently uses "LLM conversational." The engine should make this one option among several.

---

## App Types (Speculative)

Examples of apps that could be built on the platform, showing how building blocks compose differently:

### AI Assistant (Ava — exists today)
- Greeting: random informal phrases
- Process: LLM conversational (Claude + tools, streaming)
- Filler: yes (processing takes seconds)
- Listen: open speech, long timeout
- Re-prompt: gentle ("I'm still here")
- Closing: random warm goodbyes
- State: conversation history in KV

### Outbound Notification
- Greeting: "Hi, this is [org] calling about [topic]"
- Process: scripted — deliver message, optionally confirm receipt
- Filler: none
- Listen: optional, short timeout, or DTMF only
- Re-prompt: "Would you like me to repeat that?"
- Closing: immediate after delivery
- State: minimal (delivered/not-delivered)

### Survey / Feedback
- Greeting: set expectations ("This will take about 2 minutes, 5 questions")
- Process: scripted — advance through question list, record answers
- Filler: none (instant responses)
- Listen: speech or DTMF depending on question type
- Re-prompt: repeat the current question with clarification
- Closing: thank the caller, optionally summarize
- State: question index + collected answers

### Intake / Form Filler
- Greeting: "I'll need to collect some information"
- Process: hybrid — slot filling with LLM extraction for natural language input
- Filler: maybe (if validation requires an API call)
- Listen: speech, moderate timeout
- Re-prompt: repeat which field is needed
- Closing: confirm collected data, then transfer or end
- State: slot map (name, DOB, account number, etc.)

### IVR / Voice Router
- Greeting: "How can I direct your call?"
- Process: LLM single-shot — classify intent from a constrained set
- Filler: none (classification is fast)
- Listen: speech or DTMF
- Re-prompt: list available options
- Closing: transfer to the right destination
- State: none (stateless routing)

### Account Lookup
- Greeting: "I can look that up for you. What's your order number?"
- Process: lookup — validate input, call API, read back results
- Filler: yes (API call takes time)
- Listen: speech, moderate timeout
- Re-prompt: "What was that number again?"
- Closing: "Anything else?" or goodbye
- State: authenticated session + lookup results

---

## Architecture Layers

```
+------------------------------------------------------------------+
|  App Definition Layer                                            |
|  Personality, phrases, processing strategy, flow config          |
+------------------------------------------------------------------+
|  Conversation Engine                                             |
|  Turn cycle orchestration, stage dispatch, state management      |
+------------------------------------------------------------------+
|  Shared Services                                                 |
|  ClaudeClient | ConversationStore | SentenceExtractor | Utils   |
+------------------------------------------------------------------+
|  Platform Layer (exists today, mostly unchanged)                 |
|  Routes, TTS pipeline, KV streaming, /continue polling,         |
|  FreeClimb PerCL, tool registry, webhook auth, rate limiting     |
+------------------------------------------------------------------+
|  Infrastructure                                                  |
|  Cloudflare Workers, KV, FreeClimb, Google TTS, Service Bindings |
+------------------------------------------------------------------+
```

**App Definition Layer** — what app authors write. Declares personality, configures each turn-cycle stage, specifies which processing strategy to use. Minimal code for common patterns; full control available when needed.

**Conversation Engine** — new, the heart of the refactor. Manages the turn cycle: greeting → listen → process → respond → repeat. Dispatches to the right behavior at each stage based on app config. Handles state transitions.

**Shared Services** — extracted from Ava/Otto. Claude API client with retry and streaming, conversation history store, sentence extraction, goodbye detection, fetch-with-retry. Available to any app or processing strategy that needs them.

**Platform Layer** — exists today, largely unchanged. TTS pipeline (Google/ElevenLabs/FreeClimb), KV streaming orchestration, /continue polling, PerCL building, FreeClimb webhook handling, tool registry and execution, auth, rate limiting.

**Infrastructure** — Cloudflare Workers runtime, KV store, FreeClimb telephony, external APIs.

---

## Phased Roadmap

### Phase 1: Extract shared services — COMPLETE (2026-02-23)
Extracted `claude-client.ts`, `conversation.ts`, `speech-utils.ts` into `src/core/`. Ava refactored from 548 to 130 lines. Routes use shared `isGoodbye()`. Otto frozen as-is.

### Phase 2: App configuration model — COMPLETE (2026-02-23)
Introduced `BaseApp` → `ConversationalApp` / `SurveyApp` class hierarchy. Ava now ~30 lines of config. Added Rita (neutral assistant) and Coco (3-question CX survey with typed answer parsing and Claude-generated summary storage).

### Phase 3: Conversation engine + app-configurable re-prompts — COMPLETE (2026-02-23)
Introduced `src/core/engine.ts` — platform-neutral conversation engine. `processTurn()` returns a `TurnResult` discriminated union (no-input | response | stream). Routes.ts refactored to a FreeClimb adapter that pattern-matches on TurnResult type. TTS helpers extracted to `src/tts/helpers.ts` and `src/tts/streaming.ts`. Added `retryPhrases` to VoxnosApp — each app declares its own no-input retry phrases. Engine provides the abstraction boundary for a future second telephony provider; greeting flow and state management abstraction deferred until triggered by a concrete need.

### ~~Phase 4: New processing strategies~~ — ABSORBED into Phase 2
The scripted flow strategy and first non-assistant app (Coco survey) were delivered in Phase 2. Remaining items (DTMF collection, lookup strategy, LLM single-shot classification) are deferred until a concrete app requires them — no speculative building.

### Phase 4: Survey back-end (D1) — COMPLETE (2026-02-23)
D1 database `jc-voxnos-surveys` with `survey_results` table (id, survey_id, call_id UNIQUE, caller, completed_at, answers JSON, summary). SurveyApp writes to D1 on completion with KV fallback if D1 unavailable. New `src/core/survey-store.ts` data access module. Admin endpoints: `GET /survey-results` (list with survey/date/limit/offset filters) and `GET /survey-results/:id` (detail). KV retained for in-flight survey state (`survey:{callId}`, 15min TTL). Future: aggregation queries (average satisfaction, completion rate, recommend %).

### Phase 5: Multi-app routing
Route incoming calls to different apps based on phone number.

- Phone number → app mapping (KV or D1 — could share the D1 database from Phase 4)
- Admin endpoints to assign numbers to apps
- Per-app environment/secret scoping if needed

---

## Constraints

- Cloudflare Workers runtime (no Node.js APIs, no long-running processes)
- Cloudflare free tier KV limits (~1000 writes/day, ~100k reads/day)
- FreeClimb webhook timeout (~15s) bounds /continue poll window
- FreeClimb TranscribeUtterance: `rcrdTerminationSilenceTimeMs` max 3000ms
- Keep existing Ava behavior stable through all phases — no regressions
- No premature abstraction: each phase should be justified by a concrete use case or clear duplication

---

## Current State (2026-02-23)

- **Engine layer**: `processTurn()` in `src/core/engine.ts` — platform-neutral turn decisions, `TurnResult` discriminated union
- **Platform layer**: routes.ts is a FreeClimb adapter; TTS helpers and streaming pipeline in `src/tts/`
- **App layer**: modular — `BaseApp` → `ConversationalApp` / `SurveyApp` hierarchy with shared services
- **Data layer**: D1 (`jc-voxnos-surveys`) for persistent survey results; KV for ephemeral state and caching
- **Shared services**: engine, claude-client, conversation, speech-utils, survey-store extracted and reusable
- **Building blocks in use**: greeting, closing, filler, app-configurable re-prompt (retryPhrases), streaming response, tool execution, scripted Q&A with typed answer parsing, survey result persistence + admin retrieval
- **Not yet built**: DTMF, confirmation, transfer, slot filling, classification, multi-app phone routing, survey aggregation queries
- **Apps**: Ava (active, default), Rita (neutral assistant), Coco (CX survey), Otto (dormant snapshot), Echo (demo)

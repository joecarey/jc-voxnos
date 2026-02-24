# Voxnos Platform Overview

Multi-app voice platform running on Cloudflare Workers. FreeClimb telephony, Claude Sonnet 4.6 conversation AI, Google Chirp 3 HD text-to-speech (with ElevenLabs and FreeClimb built-in as alternatives). Create and deploy voice assistants and deterministic apps via API — no code changes, no redeploys.

## Features

### Core Voice Engine
- **Multi-app architecture** — multiple independent voice apps behind one phone system, each with its own personality, tools, and voice
- **Intent routing** — River front-door app classifies caller intent via Claude and transfers to the right specialist
- **Warm transfer** — passes caller's request summary to the target app so they don't have to repeat themselves
- **Cold transfer** — routes to target app with a fresh greeting (surveys, generic requests)
- **Conversation engine** — platform-neutral turn cycle that decouples business logic from telephony
- **Streaming TTS pipeline** — sentence-by-sentence audio delivery via KV chain with redirect polling
- **Pre-filler acknowledgments** — cached phrases ("On it.", "One sec.") played immediately on 50% of turns to mask API latency
- **Hangup-via-KV** — background stream detects goodbyes and signals the polling chain to hang up gracefully
- **Goodbye detection** — single source of truth used by engine, apps, and streaming pipeline

### App Framework
- **Zero-code conversational apps** — create via API with system prompt, greetings, fillers, goodbyes, tool selection, voice
- **Zero-code deterministic apps** — scripted, non-LLM app type for structured interactions. SurveyApp is the first implementation: sequential typed questions (yes/no, 1-5 scale, open-ended) with answer parsing and Claude-generated summaries
- **Three-tier error escalation** — gentle re-ask, rephrased prompt, graceful bail with apology
- **ASR mistranscription tolerance** — phonetic near-miss map for scale responses (handles "five" transcribed as "bye", etc.)
- **Per-app tool filtering** — each app chooses which tools Claude can use; tools are code, tool assignment is data
- **D1 fallback** — code-defined assistants auto-register if the database is unavailable at startup

### Text-to-Speech
- **Google Chirp 3 HD** — primary TTS engine, LINEAR16 WAV at 8kHz telephony sample rate
- **ElevenLabs** — alternative high-quality TTS provider, selectable via `TTS_MODE=11labs`
- **FreeClimb built-in Say** — always-available fallback; automatically used if the primary TTS provider fails
- **Per-app voice selection** — each app gets its own voice, threaded through all TTS paths with cache isolation to prevent cross-app collisions

### Telephony
- **FreeClimb integration** — webhook-driven call handling with PerCL command generation
- **Phone number routing** — D1 table maps E.164 numbers to apps, with default app fallback
- **Webhook signature validation** — FreeClimb signing secret verification on all call webhooks

### AI and Tools
- **Claude Sonnet 4.6** — streaming and non-streaming modes with KV-backed conversation history
- **Tool system** — pluggable registry with per-app filtering (weather, knowledge base, internal transfer)
- **Cognos integration** — knowledge base queries via Cloudflare Service Binding (internal routing, no public URL)
- **Conversation history compression** — tool result blocks are truncated before saving to KV, keeping token counts bounded across multi-turn calls
- **Daily cost tracking** — per-day input/output token accumulation in KV with 14-day admin reporting

### Data and Observability
- **Call Detail Records** — every call logged with turn-by-turn detail (transcripts, responses, fillers, transfers, tool use)
- **Survey results storage** — D1-backed with KV fallback, Claude-generated summaries
- **Admin API** — full CRUD for app definitions, phone routes; read access for survey results, CDR, cost reports. Apps take effect immediately on create/update — no restart or redeploy needed
- **FreeClimb admin wrappers** — account debug, phone number management, application setup, call logs

### Infrastructure
- **Cloudflare Workers** — edge deployment, sub-50ms cold start, no origin server
- **D1 database** — app definitions, phone routes, call detail records, survey results
- **KV storage** — conversation history, TTS audio cache, streaming state, rate limiting, cost tracking
- **Rate limiting** — configurable per-endpoint KV-based rate limits (call start, conversation turns, admin API)
- **HMAC-signed TTS URLs** — prevents unauthorized audio generation on the on-demand TTS endpoint

## Architecture

The codebase separates cleanly into layers that can be understood and modified independently:

**Engine** (`src/engine/`) owns the "what happens this turn" decisions. It returns a discriminated union (`TurnResult`) that the telephony layer pattern-matches on. The engine knows nothing about FreeClimb, TTS providers, or KV — it's pure conversation logic. If you wanted to run these apps over WebSockets or a different telephony provider, the engine wouldn't change.

**Telephony** (`src/telephony/`) is the FreeClimb adapter. It converts `TurnResult` into PerCL commands, manages the streaming TTS pipeline, and handles the transfer machinery. If you swapped FreeClimb for Twilio, this directory gets replaced and nothing else changes.

**Services** (`src/services/`) are stateless data access modules. Claude client, conversation history, survey store, app store, CDR store. No business logic — just reads and writes. Fire-and-forget CDR writes never block the call path.

**Admin** (`src/admin/`) handles all admin API endpoints. Validation, auth gating, CRUD operations. Separated from the main routing table so `index.ts` stays clean.

**Apps** define personality and behavior through configuration, not code. A conversational app is a system prompt, greeting phrases, filler phrases, goodbye phrases, a voice, and an optional tool list. A survey app is a greeting, a set of typed questions, and a closing. Both are JSON blobs in D1 — no TypeScript, no deploys.

The streaming pipeline deserves a note. Voice UX lives and dies on latency. Claude's time-to-first-token is 1-3 seconds, and TTS adds another 500ms per sentence. The platform attacks this from two angles: pre-fillers (cached acknowledgment phrases played immediately while Claude thinks) and sentence-level streaming (each sentence is TTS'd and stored in KV as soon as it's ready, with a redirect chain polling for the next one). The result is that callers hear *something* within 200ms of speaking, and the real response starts flowing within 2-4 seconds.

River as an intent router is worth calling out. Rather than building routing logic into the telephony layer, River is just another conversational app — it happens to have a system prompt that says "classify intent and transfer." This means routing logic is prompt-engineerable, not code-engineerable. Want to add a new specialist? Create the app via API, update River's prompt to know about it. No deploys.

The warm transfer path is the most complex interaction in the system. When River transfers with a caller intent, the target app skips its greeting, receives the intent as a synthetic first message, and responds directly. The caller says "I need the weather in Austin" to River, and Ava's first words are the forecast — no "Hi, I'm Ava" in between. This requires coordination across KV (transfer context), the route handler (skipping onStart, injecting synthetic input), and the engine (normal processTurn from there). It's the kind of thing that makes voice AI feel like talking to a team of people rather than navigating a phone tree.

What's notable about the overall design is how much is data-driven. App personalities, tool assignments, phone routing, voice selection — all managed via API, stored in D1, loaded at startup. The code defines *capabilities* (streaming, tool execution, survey logic, transfer mechanics). The data defines *behavior* (who says what, who has which tools, which number rings which app). That separation is what makes it possible to iterate on the voice experience without touching code.

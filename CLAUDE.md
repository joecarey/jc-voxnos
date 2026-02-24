# jc-voxnos

Multi-app voice platform: FreeClimb telephony + Claude Sonnet 4.6 + Google Chirp 3 HD TTS.

**Response style**: No code snippets in explanations — describe changes in prose. Show diffs or code only when explicitly asked.

**Call flow**: `/call` → App Router → `app.onStart()` greeting. `/conversation` → Engine `processTurn()` → TurnResult → FreeClimb adapter → PerCL + TTS.

**Source layout**:
- `src/index.ts` — entry point, HTTP router, admin endpoints
- `src/engine/` — conversation engine + app framework (types, engine, base-app, conversational-app, survey-app, registry, speech-utils)
- `src/telephony/` — FreeClimb adapter (routes, percl)
- `src/services/` — shared clients (claude-client, conversation, survey-store, app-store, cdr-store)
- `src/platform/` — HTTP infrastructure (auth, webhook-auth, rate-limit, env)
- `src/apps/` — concrete app instances (ava, rita, otto, echo)
- `src/tts/` — TTS providers (google, elevenlabs, freeclimb, helpers, streaming)
- `src/tools/` — tool system (registry, weather, cognos, transfer)

## App Type Hierarchy

```
VoxnosApp (interface — platform contract)
├── BaseApp (abstract — logging, KV cleanup)
│   ├── ConversationalApp (LLM turn cycle: Claude + history + streaming)
│   │   └── (D1-driven — Ava, Rita, etc.)
│   └── SurveyApp (scripted Q&A: sequential questions, typed answer parsing)
│       └── (D1-driven — Coco, etc.)
└── EchoApp (implements VoxnosApp directly)
```

## Registered Apps

### Static (code-defined)
- `EchoApp` — demo only, implements VoxnosApp directly
- `OttoAssistant` — dormant snapshot of pre-Ava assistant (2026-02-23); not routed to any FreeClimb number

### Dynamic (D1-driven — `app_definitions` table)
Loaded from `app_definitions` table at Worker startup. Each active row becomes a `ConversationalApp` or `SurveyApp` instance registered with `{ dynamic: true }`. Managed via `POST /apps/definitions`, `DELETE /apps/definitions/:id`, `POST /reload-apps`.
- `river` — **default** — ConversationalApp, intent router, voice: Leda. Greets callers, classifies intent via Claude, transfers to the right app using `transfer_to_app` tool. No other tools — never answers questions directly.
- `ava` — ConversationalApp, Claude Sonnet 4.6, tools (weather + cognos), voice: Despina, streaming TTS. Warm/familiar personality, informal greetings, short fillers.
- `rita` — ConversationalApp, neutral/professional personality, tools (weather + cognos).
- `coco` — SurveyApp, 3-question CX demo (satisfaction/scale, recommend/yes_no, feedback/open), voice: Aoede

**Fallback**: if D1 is unavailable at startup, code-defined `AvaAssistant` and `RitaAssistant` (`src/apps/ava.ts`, `src/apps/rita.ts`) are registered instead.

### Phone Routing
`phone_routes` table maps phone numbers (E.164) to app IDs. Loaded at startup. `registry.getForNumber()` checks routes first, falls back to the default app. Managed via `POST /phone-routes`, `DELETE /phone-routes/:phoneNumber`.

### Internal Call Transfer
Apps can transfer a call to another app mid-session using the `transfer_to_app` tool. The tool writes two KV keys: `call-app:{callId}` → `{appId}` (durable override, written once) and `call-app:{callId}:pending` → `1` (one-shot flag). Optionally writes a third key `call-transfer-context:{callId}` with JSON `{ intent }` when `caller_intent` is provided (warm transfer). Two-key design avoids KV eventual-consistency races — the app override is never rewritten. Cleaned up in `BaseApp.onEnd()`.

**Cold transfer** (no intent or target is SurveyApp): route handler calls `onStart()` on the target app, delivers its greeting. Same as a fresh call.

**Warm transfer** (intent present + target has `streamSpeech`): route handler skips `onStart()`, injects the caller's intent as a synthetic `SpeechInput`, and falls through to normal `processTurn()`. The target app's Claude sees the intent as the first user message and responds directly — no greeting, no repeat. Normal streaming and pre-filler infrastructure kicks in.

## HTTP Endpoints

### FreeClimb Webhooks (FREECLIMB_SIGNING_SECRET validated)
- `POST /call` — incoming call, returns PerCL greeting + TranscribeUtterance
- `POST /conversation` — each speech turn, returns PerCL response

### TTS (public, HMAC-signed URLs)
- `GET /tts` — on-demand: `?text=...&sig=...` — validates HMAC, calls Google/ElevenLabs, returns audio
- `GET /tts-cache` — KV-backed: `?id=...` — serves pre-generated audio, `Cache-Control: no-store`
- `GET /continue` — streaming chain: polls KV for next sentence (25×500ms, ~12.5s max), returns Play+Redirect, Play+Pause+Hangup (if hangup marker), or TranscribeUtterance

### Admin (Bearer: ADMIN_API_KEY)
- `GET /debug/account`, `GET /phone-numbers`, `POST /setup`, `POST /update-number`, `POST /update-app`
- `GET /logs` — FreeClimb call logs, `GET /costs` — 14-day Anthropic token usage
- `GET /survey-results?survey=coco&from=2026-02-01&to=2026-02-28&limit=50&offset=0` — list survey results (all params optional)
- `GET /survey-results/:id` — single survey result by ID
- `GET /apps/definitions` — list all app definitions (active + inactive)
- `GET /apps/definitions/:id` — single app definition by ID
- `POST /apps/definitions` — create/update an app definition (validates per type, registers in-memory immediately)
- `DELETE /apps/definitions/:id` — soft-delete app definition + remove from in-memory registry
- `GET /phone-routes` — list all phone number → app routes
- `POST /phone-routes` — create/update a phone route (`{ phone_number, app_id, label? }`)
- `DELETE /phone-routes/:phoneNumber` — delete a phone route
- `POST /reload-apps` — force re-read all definitions and routes from D1
- `GET /cdr?app_id=ava&from=2026-02-01&to=2026-02-28&caller=+1...&limit=50&offset=0` — list call detail records (all params optional)
- `GET /cdr/:callId` — single CDR with full turn-by-turn detail

### Public
- `GET /` — health check, `GET /apps` — list registered apps

## TTS Configuration

**Active**: `TTS_MODE=google` → Google Chirp 3 HD, LINEAR16 WAV 8kHz
**Default voice**: `en-US-Chirp3-HD-Despina` (used when app has no `config.voice`)
**Per-app voices**: each app definition can set `config.voice` to a full Google voice name (e.g. `en-US-Chirp3-HD-Leda`). Threaded through `callTTS(text, env, voice)`, `voiceSlug(env, voice)`, `applyGreetingTTS(..., voice)`, and `processRemainingStream` via `StreamOpts.voice`. Current assignments: Ava=Despina, River=Leda, Coco=Aoede, Rita=default.
**Modes**: `google` (active) | `11labs` (direct ElevenLabs) | `freeclimb` (built-in, always fallback)
**Fallback**: google/11labs failure → FreeClimb built-in Say automatically
**Cache key rule**: stable keys append `voiceSlug(env, voice)` (derives slug from per-app voice or global default); `/tts-cache` always `Cache-Control: no-store`

## Streaming Flow (TTS_MODE=google|11labs)

1. `streamSpeech()` yields sentences from Claude's streaming response
2. **Pre-filler path** (50% coin flip, non-goodbye): cached filler ("On it.", "One sec.") played immediately → full stream runs in background → `/continue` picks up real sentences. Skips app-yielded fillers to prevent double-filler.
3. **Standard path** (other 50% or no fillerPhrases): first sentence TTS'd immediately → KV → `Play` + `Redirect` to `/continue`
4. Remaining: background via `ctx.waitUntil()`, stored in KV with per-turn UUID
5. `/continue` polls KV (25×500ms, ~12.5s max); keeps polling while `:pending` marker exists, exits early on `:done` → `Play+Redirect`, `Play+Pause+Hangup` (hangup marker), or `TranscribeUtterance`
6. **Hangup-via-KV**: `processRemainingStream` detects hangup chunks, writes `{callKey}:hangup` marker, `/continue` returns Hangup instead of Redirect

## KV Schema (RATE_LIMIT_KV)

| Key pattern | Value | TTL | Purpose |
|---|---|---|---|
| `tts:{stable-key}-{VOICE_SLUG}` | audio ArrayBuffer | 6hr | greetings, fillers, retry phrases |
| `tts:{uuid}` | audio ArrayBuffer | 120s | per-sentence streaming audio |
| `stream:{callId}:{turnId}:{n}` | UUID string | 120s | sentence index pointer |
| `stream:{callId}:{turnId}:pending` | `'1'` | 120s | stream-alive signal (written on entry) |
| `stream:{callId}:{turnId}:done` | `'1'` | 120s | stream completion signal |
| `stream:{callId}:{turnId}:hangup` | sentence index string | 120s | hangup marker for /continue |
| `conv:{callId}` | JSON messages | 15min | conversation history |
| `call-app:{callId}` | app ID string | 15min | durable per-call app override for internal transfers |
| `call-app:{callId}:pending` | `'1'` | 15min | one-shot transfer greeting flag (deleted after delivery) |
| `call-transfer-context:{callId}` | JSON `{ intent }` | 15min | warm transfer context (caller's request summary) |
| `rl:{prefix}:{id}:{bucket}` | count string | 120s | rate limiting |
| `costs:voxnos:{date}` | JSON token counts | 90d | cost tracking |
| `survey:{callId}` | JSON survey state | 15min | in-flight survey progress (question index + answers) |
| `survey-results:{callId}` | JSON results + summary | 24hr | completed survey fallback (when D1 is unavailable) |

## D1 Schema (DB — jc-voxnos)

### `survey_results` table

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, autoincrement |
| `survey_id` | TEXT NOT NULL | App ID (e.g. "coco") — indexed |
| `call_id` | TEXT NOT NULL UNIQUE | FreeClimb call ID |
| `caller` | TEXT NOT NULL | Caller phone number |
| `completed_at` | TEXT NOT NULL | ISO 8601 timestamp — indexed |
| `answers` | TEXT NOT NULL | JSON: `SurveyAnswer[]` |
| `summary` | TEXT NOT NULL | Claude-generated 2-3 sentence summary |

SurveyApp writes to D1 on completion. Falls back to KV (`survey-results:{callId}`, 24hr TTL) if D1 binding is absent.

### `app_definitions` table

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Primary key (app ID, e.g. "ava", "coco") |
| `name` | TEXT NOT NULL | Display name |
| `type` | TEXT NOT NULL | `conversational` or `survey` |
| `config` | TEXT NOT NULL | JSON blob — shape depends on `type` (see below) |
| `active` | INTEGER NOT NULL | 1 = active, 0 = soft-deleted (default 1) |
| `is_default` | INTEGER NOT NULL | 1 = default app for unrouted calls (default 0) |
| `created_at` | TEXT NOT NULL | ISO 8601 (default `datetime('now')`) |
| `updated_at` | TEXT NOT NULL | ISO 8601 (default `datetime('now')`) |

**Conversational config**: `{ systemPrompt, greetings[], fillers[], goodbyes[], retries?[], model?, tools?[], voice? }`. `tools` is an array of tool name strings resolved against `ToolRegistry` at startup. `voice` is a full Google TTS voice name (e.g. `en-US-Chirp3-HD-Leda`); when absent, the global default is used.

**Survey config**: `{ greeting, closing, questions[{label,text,type}], retries?[], voice? }`. `voice` same as conversational.

Active definitions are loaded into memory at Worker startup. CRUD via admin endpoints (`/apps/definitions`).

### `phone_routes` table

| Column | Type | Notes |
|---|---|---|
| `phone_number` | TEXT | Primary key (E.164 format) |
| `app_id` | TEXT NOT NULL | References `app_definitions.id` |
| `label` | TEXT | Optional human-readable label |
| `created_at` | TEXT NOT NULL | ISO 8601 (default `datetime('now')`) |
| `updated_at` | TEXT NOT NULL | ISO 8601 (default `datetime('now')`) |

Loaded at startup into `registry.phoneRoutes`. CRUD via admin endpoints (`/phone-routes`).

### `call_records` table (CDR)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, autoincrement |
| `call_id` | TEXT NOT NULL UNIQUE | FreeClimb call ID |
| `app_id` | TEXT NOT NULL | App that handled the call — indexed |
| `caller` | TEXT NOT NULL | Caller phone number |
| `callee` | TEXT NOT NULL | Called phone number |
| `started_at` | TEXT NOT NULL | ISO 8601 — indexed |
| `ended_at` | TEXT | ISO 8601 (set on finalization) |
| `duration_ms` | INTEGER | Computed from `started_at` → `ended_at` |
| `outcome` | TEXT NOT NULL | `in_progress`, `completed`, `no_response`, `error` |
| `turn_count` | INTEGER NOT NULL | Counted from `call_turns` at finalization |
| `total_input_tokens` | INTEGER NOT NULL | Accumulated Claude input tokens |
| `total_output_tokens` | INTEGER NOT NULL | Accumulated Claude output tokens |

Written at call start (`createCallRecord`), finalized at hangup/goodbye (`endCallRecord`). Fire-and-forget — never blocks the call.

### `call_turns` table (CDR)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, autoincrement |
| `call_id` | TEXT NOT NULL | References `call_records.call_id` — indexed |
| `seq` | INTEGER NOT NULL | Auto-assigned sequence within the call (UNIQUE with call_id) |
| `turn_type` | TEXT NOT NULL | See turn types below |
| `speaker` | TEXT NOT NULL | `caller` or `system` |
| `content` | TEXT | The actual text spoken (transcript or TTS text) |
| `meta` | TEXT | Optional JSON blob for structured data |

**Turn types**: `greeting` (system greeting), `caller_speech` (transcribed input), `assistant_response` (Claude's full text reply, all sentences joined), `filler` (acknowledgment phrase), `no_input` (caller said nothing, retry played), `goodbye` (farewell, call ending), `transfer` (internal app handoff, meta: `{to_app}`), `tool_use`, `error`.

CDR turns are written fire-and-forget at each event point in the route handler. Streaming responses are collected via `onStreamComplete` callback and written as a single `assistant_response` turn when the stream finishes.

## Invariants

- Keep FreeClimb webhook signature validation
- Keep per-turn UUID in KV keys — prevents stale cross-turn reads
- Do not weaken rate limiting
- Keep `voiceSlug(env, voice)` appended to all stable TTS cache keys — per-app voice must flow through to prevent cache collisions
- Keep `Cache-Control: no-store` on all `/tts-cache` responses
- Pre-filler path must skip app-yielded fillers (`skipFillers`) to prevent double-filler
- `processRemainingStream` must write `:pending` on entry, hangup marker on hangup chunks, and fire `onHangup`

## Cognos Dependency

Calls `POST /brief` via Cloudflare Service Binding (`env.COGNOS` Fetcher) — internal routing, no public URL.

- Auth: `COGNOS_PUBLIC_KEY` Bearer token
- Request: `{q, voice_mode: true, voice_detail: 1–5}`
- Response: `answer` field (speakable text, no URLs/citations)
- **Stability rule**: if cognos changes this contract, update this section.

## Conversation Engine (src/engine/engine.ts)

Platform-neutral turn-cycle orchestration. `processTurn(app, context, input, opts)` makes the "what happens this turn" decisions and returns a `TurnResult` discriminated union:
- `no-input` — caller said nothing, includes app-specific retry phrase (falls back to `DEFAULT_RETRY_PHRASES`)
- `response` — non-streaming app response from `onSpeech`
- `stream` — streaming response with optional pre-filler decision, `cleanup` callback for `onEnd`

Routes pattern-match on `TurnResult.type` to produce FreeClimb PerCL + TTS. The engine owns no TTS, KV, or telephony concerns.

## Engine (src/engine/)

- **`types.ts`** — `Env`, `AppContext`, `SpeechInput`, `AppResponse`, `StreamChunk`, `VoxnosApp` interface.
- **`engine.ts`** — Conversation engine. `processTurn()`, `TurnResult` type, `DEFAULT_RETRY_PHRASES`. Decides no-input/streaming/pre-filler per turn.
- **`base-app.ts`** — `BaseApp` abstract class implementing `VoxnosApp`. Handles call lifecycle logging (`call_start`/`call_end`), KV cleanup in `onEnd` (`conv:{callId}`, `call-app:{callId}`, `call-app:{callId}:pending`, `call-transfer-context:{callId}`). Exposes `fillerPhrases`, `retryPhrases`, and `voice`. Subclasses implement `getGreeting()` and `onSpeech()`.
- **`conversational-app.ts`** — `ConversationalApp extends BaseApp`. LLM-conversational pattern: goodbye detection, conversation history, Claude delegation, streaming with filler tagging. Configured via `AssistantConfig` (id, name, systemPrompt, greetings, fillers, goodbyes, retries, model, tools, voice). `tools` is an optional string array of tool names — when set, only those tools are sent to Claude (per-app filtering). `voice` sets the Google TTS voice for this app.
- **`survey-app.ts`** — `SurveyApp extends BaseApp`. Scripted Q&A: sequential questions, typed answer parsing, Claude-generated summary. Three-tier error escalation: tier 1 gentle re-ask, tier 2 rephrased prompt, tier 3 (or 5 total errors across all questions) graceful bail with apology + hangup. Configured via `SurveyConfig` (id, name, greeting, closing, questions, retries, voice).
- **`registry.ts`** — `AppRegistry` singleton. Maps app IDs to instances (with `dynamic` flag for D1-loaded apps), resolves phone numbers to apps via `phoneRoutes` map. `register(app, opts?)` accepts `{ isDefault?, dynamic? }`. `getForNumber(phone)` checks `phoneRoutes` first, falls back to `defaultApp`. `setPhoneRoute(phone, appId)` / `removePhoneRoute(phone)` / `clearPhoneRoutes()` manage routing. `removeDynamic()` clears all D1-loaded entries, phone routes, and default for clean reload. `remove(appId)` removes a single entry.
- **`speech-utils.ts`** — `fetchWithRetry()`, `extractCompleteSentences()`, `isGoodbye()`. Pure functions. `isGoodbye` is the single source of truth (used by engine and apps).

## Services (src/services/)

- **`claude-client.ts`** — `streamClaude(config, context, messages)` async generator, `callClaude(config, context, history)` non-streaming, `trackDailyCost(kv, input, output)`. Parameterized via `ClaudeConfig` (systemPrompt, model, fillerPhrases, toolNames). `toolNames` enables per-app tool filtering — when set, only named tools are sent to Claude; when undefined, all registered tools are sent. Default model: `CLAUDE_MODEL`.
- **`conversation.ts`** — `ContentBlock`/`Message` types, `compressToolResults()`, `getMessages()`, `saveMessages()`. KV conversation history with 15-min TTL.
- **`survey-store.ts`** — D1 data access for survey results only. `saveSurveyResult(db, result)`, `listSurveyResults(db, opts)`, `getSurveyResult(db, id)`. Used by SurveyApp (write) and admin endpoints (read).
- **`app-store.ts`** — D1 data access for `app_definitions` and `phone_routes` tables. App definitions: `loadAllActiveApps`, `loadAppDefinition`, `saveAppDefinition`, `deleteAppDefinition` (soft-delete), `listAppDefinitions`. Phone routes: `loadPhoneRoutes`, `savePhoneRoute`, `deletePhoneRoute`. Pure data access, no app dependencies.
- **`cdr-store.ts`** — D1 data access for `call_records` and `call_turns` (CDR). Writes: `createCallRecord`, `endCallRecord`, `updateCallTokens`, `addTurn`, `addTurnsBatch`. Reads: `getCallRecord`, `getCallTurns`, `listCallRecords` (paginated with filters). Seq auto-assigned via `MAX(seq)+1`. All write functions designed for fire-and-forget.

## Telephony (src/telephony/)

- **`routes.ts`** — FreeClimb adapter. Converts engine `TurnResult` to PerCL + TTS. Handles `/call` and `/conversation` webhooks. `handleConversation` checks `call-app:{callId}` KV override before phone-route resolution for internal transfers. `applyGreetingTTS()` handles greeting audio (stable cache keys, long TTL). `applyResponseTTS()` handles non-streaming responses (UUID keys, short TTL) — used by SurveyApp and streaming fallback paths to avoid voice drop to FreeClimb Say. If you swapped telephony providers, this directory gets replaced.
- **`percl.ts`** — PerCL command builder. `buildPerCL(response, baseUrl, ttsProvider)` converts `AppResponse` to FreeClimb JSON commands.

## Platform (src/platform/)

- **`auth.ts`** — `requireAdminAuth(request, env)`, Bearer token validation against `ADMIN_API_KEY`.
- **`webhook-auth.ts`** — FreeClimb webhook signature validation.
- **`rate-limit.ts`** — KV-based rate limiting with configurable buckets.
- **`env.ts`** — Environment variable validation on startup.

## TTS Modules (src/tts/)

- **`helpers.ts`** — `voiceSlug(env, voice?)`, `greetingCacheKey(text, slug)`, `callTTS(text, env, voice?)`, `getTTSProvider(env)`, `sanitizeForTTS(text)`. Shared TTS infrastructure used by routes and streaming. Per-app voice threaded via optional `voice` parameter.
- **`streaming.ts`** — `processRemainingStream(sentenceStream, callKey, env, startIndex, opts)`. Background KV streaming pipeline for sentence-by-sentence TTS delivery. `StreamOpts.voice` passes per-app voice through to `callTTS`.
- **`google.ts`** — Google Chirp 3 HD TTS client.
- **`elevenlabs.ts`** — ElevenLabs TTS client + HMAC signing.
- **`freeclimb.ts`** — TTSProvider implementations (DirectElevenLabsProvider, FreeClimbDefaultProvider).

Creating a new app: `POST /apps/definitions` with type `conversational` or `survey` — no code changes needed. See "Adding a New App" below.

## Recent changes

- **SurveyApp TTS fix + three-tier error escalation**: Non-streaming responses (SurveyApp, streaming fallback) now pre-generate Google TTS audio via `applyResponseTTS` before `buildPerCL`, preventing voice drop to FreeClimb's built-in Say. Three-tier error escalation in `SurveyApp.onSpeech`: tier 1 gentle re-ask, tier 2 rephrased last-chance prompt, tier 3 graceful bail with apology + hangup. Global error cap: 5 total parse failures across all questions triggers immediate bail. `SurveyState` extended with `retriesForQuestion` and `totalErrors` counters; per-question counter resets on successful parse.
- **D1 database rename**: Renamed `jc-voxnos-surveys` → `jc-voxnos` to reflect the database's broader scope (app definitions, phone routes, CDR, and survey results — not just surveys). Schema and data migrated to new database, old one deleted. `wrangler.toml` binding updated.
- **Per-app TTS voices + River prompt polish**: Each app can now set `config.voice` in its D1 definition (full Google voice name, e.g. `en-US-Chirp3-HD-Leda`). Voice threads from `VoxnosApp.voice` through `callTTS`, `voiceSlug`, `applyGreetingTTS`, and `processRemainingStream` via `StreamOpts.voice`. Cache keys include the per-app voice slug, preventing cross-app cache collisions. Apps without a voice field use the global default (Despina). Current assignments: Ava=Despina, River=Leda, Coco=Aoede. River's system prompt updated to avoid call-medium references ("have a great call" → "have a good day").
- **Warm transfer + River prompt hardening**: `transfer_to_app` tool now accepts optional `caller_intent` field. When present, writes `call-transfer-context:{callId}` to KV with the caller's request summary. Route handler forks on transfer: warm path (intent + ConversationalApp target) skips `onStart()`, injects intent as synthetic `SpeechInput`, falls through to `processTurn()` — target Claude responds directly without greeting. Cold path (no intent or SurveyApp target) delivers greeting as before. River's system prompt rewritten: voice-mode guard (no emojis/markdown), people-not-apps framing (Ava and Coco as colleagues), 3-strike intent escalation (suggest → insist → apologize+hangup), and warm transfer instructions (populate `caller_intent` for specific requests, leave empty for generic "let me talk to Ava"). Two-key KV design (durable override + one-shot pending flag) preserved from prior fix for eventual-consistency races.
- **River intent router + internal call transfer**: River is a D1-defined ConversationalApp (`is_default: true`) that greets callers, classifies intent via Claude, and transfers to the right app using `transfer_to_app` tool. Transfer mechanism: `TransferTool` writes `call-app:{callId}` → app ID to KV; route handler detects pending flag on the next webhook, clears conversation history, delivers target app response. `ToolContext` interface added to `src/tools/types.ts` — threads `{ callId, env }` through `ToolRegistry.execute()` and both `streamClaude`/`callClaude` tool-use loops. Backward-compatible: existing tools ignore the extra param. `applyGreetingTTS()` helper extracted in `routes.ts` to share greeting TTS logic between initial calls and transfers. Direct phone lines: Ava (+15123083004) and Coco (+15122712496) bypass River via `phone_routes`. New file: `src/tools/transfer.ts`.
- **Call Detail Records (CDR)**: D1-backed call logging with `call_records` and `call_turns` tables. Every call is recorded at start, every event (greeting, caller speech, assistant response, filler, no-input, goodbye) written as a turn with the actual text content. Streaming responses collected via `onStreamComplete` callback in `processRemainingStream` and written as a single joined `assistant_response` turn. All CDR writes are fire-and-forget — never block the call. Admin endpoints: `GET /cdr` (list with pagination/filters) and `GET /cdr/:callId` (full turn-by-turn detail). New `src/services/cdr-store.ts` data access module. `StreamOpts` extended with `onStreamComplete` callback.
- **D1-driven app definitions + phone routing**: All app configs (conversational and survey) now live in D1 `app_definitions` table with a `type` discriminator and JSON `config` blob. `survey_definitions` table dropped. Worker startup loads active definitions from D1 and registers `ConversationalApp` or `SurveyApp` instances dynamically. New admin endpoints: `GET/POST /apps/definitions`, `GET/DELETE /apps/definitions/:id`, `POST /reload-apps`. Old `/surveys` and `/reload-surveys` endpoints removed. Per-app tool filtering via `ClaudeConfig.toolNames` — tools are code implementations, tool *assignment* is data. Phone number routing via `phone_routes` table: `GET/POST /phone-routes`, `DELETE /phone-routes/:phoneNumber`. Registry tracks `dynamic` flag and `phoneRoutes` map. D1 fallback: code-defined `AvaAssistant`/`RitaAssistant` registered if D1 unavailable. `src/services/app-store.ts` added for D1 data access. `survey-store.ts` slimmed to results-only (definition CRUD removed).
- **Codebase reorganization**: Replaced monolithic `src/core/` with purpose-aligned directories: `src/engine/` (app framework + turn cycle), `src/services/` (Claude client, conversation, survey store), `src/telephony/` (FreeClimb routes + PerCL), `src/platform/` (auth, rate limiting, env). SurveyApp moved from `apps/survey.ts` to `engine/survey-app.ts`. `sanitizeForTTS` moved from percl to `tts/helpers.ts`. Old `src/core/` and `src/percl/` directories removed.
- **Phase 4 survey back-end (D1)**: Added D1 database (originally `jc-voxnos-surveys`, now `jc-voxnos`) with `survey_results` table. SurveyApp writes to D1 on completion (KV fallback if D1 unavailable). New data access module `src/services/survey-store.ts`. Admin endpoints: `GET /survey-results` (list with filters) and `GET /survey-results/:id` (detail). `DB?: D1Database` added to Env as optional binding.
- **Phase 3 conversation engine + app-configurable re-prompts**: Introduced `src/engine/engine.ts` — platform-neutral conversation engine returning `TurnResult` discriminated union. Routes refactored to a FreeClimb adapter that pattern-matches on TurnResult. TTS helpers extracted to `src/tts/helpers.ts` and `src/tts/streaming.ts`. Added `retryPhrases` to `VoxnosApp` interface — each app declares its own no-input retry phrases.
- **Phase 2 app configuration model**: Introduced `BaseApp` → `ConversationalApp` → `SurveyApp` class hierarchy. Ava refactored to ~30-line config declaration. Added Rita (neutral assistant) and Coco (3-question CX survey).
- **Phase 1 shared services extraction**: Extracted Claude API client, conversation history management, and speech utilities into shared modules.
- **Ava rebrand**: `ClaudeAssistant` → `AvaAssistant` (`src/apps/ava.ts`). Named system prompt ("You are Ava"), informal greetings (random, no time-of-day), short fillers, warm goodbyes.
- **Otto snapshot**: `OttoAssistant` (`src/apps/otto.ts`) — frozen copy of pre-Ava assistant with original personality. Dormant (no FreeClimb number).
- **Pre-filler acknowledgments**: route layer plays a cached filler immediately on 50% of non-goodbye turns (`PRE_FILLER_PROBABILITY`). Fills dead air during Anthropic API TTFB. `VoxnosApp.fillerPhrases` lets each app declare its own set.
- **Hangup-via-KV marker**: `processRemainingStream` writes `{callKey}:hangup` when it encounters a hangup chunk. `/continue` checks this and returns Play+Pause+Hangup. Covers edge cases where goodbye detection at the route layer has a false negative.
- **Cognos Service Binding**: `env.COGNOS` Fetcher replaces public workers.dev URL — eliminates same-account edge routing 404s.
- **Tool result compression**: `compressToolResults()` truncates tool_result blocks >120 chars before saving to KV, keeping token count bounded across multi-turn calls.
- `/continue` poll window increased from 15 to 25 attempts (~12.5s max).
- Removed dead code: `/transfer`, `OutDial`, unused rate limit configs, `@supabase/supabase-js`.

Downstream impact:
- All `src/core/` imports changed to `src/engine/`, `src/services/`, or `src/platform/`. All `src/percl/` imports changed to `src/telephony/`. `src/routes.ts` moved to `src/telephony/routes.ts`.
- `registry.register()` signature: `(app, opts?: { isDefault?, dynamic? })`. `getForNumber()` checks `phoneRoutes` before `defaultApp`.
- `src/apps/coco.ts` removed. `src/apps/ava.ts` and `src/apps/rita.ts` kept as D1 fallback only. `survey_definitions` table dropped, replaced by `app_definitions` + `phone_routes`.
- `ClaudeConfig` extended with `toolNames?: string[]`. `AssistantConfig` extended with `tools?: string[]`. Backward-compatible — undefined means all tools.
- `/surveys`, `/surveys/:id`, `/reload-surveys` endpoints removed. Replaced by `/apps/definitions`, `/phone-routes`, `/reload-apps`.
- `survey-store.ts` no longer exports definition CRUD functions. `app-store.ts` handles all definition and route data access.
- `Tool.execute()` signature extended with optional `ToolContext` parameter. Existing tools unaffected. New tools needing call context (like `transfer_to_app`) receive `{ callId, env }` from the Claude client.
- `call-app:{callId}` + `call-app:{callId}:pending` + `call-transfer-context:{callId}` KV keys used for internal transfers. `BaseApp.onEnd()` deletes all three alongside `conv:{callId}`. Route handler checks these before `registry.getForNumber()` — KV override takes precedence over phone routing.
- `transfer_to_app` tool accepts optional `caller_intent` field. Warm transfer (intent present + ConversationalApp target) skips greeting and falls through to `processTurn()`. Cold transfer (no intent or SurveyApp) delivers greeting as before.
- `routes.ts` exports `applyGreetingTTS()` helper (extracted from `handleIncomingCall`). Cold transfer and initial call handler both use it.
- River is the default app (`is_default: true`). Ava is no longer default. Unrouted numbers reach River.
- `VoxnosApp.voice?: string` added to interface. `BaseAppConfig`, `AssistantConfig`, `SurveyConfig` all accept optional `voice`. `callTTS(text, env, voice?)` and `voiceSlug(env, voice?)` accept per-app voice override. `applyGreetingTTS` accepts voice. `StreamOpts.voice` passes voice into `processRemainingStream`. Backward-compatible — undefined means global default.
- Keep `COGNOS_PUBLIC_KEY` and `COGNOS` Service Binding present in env.

## Environment

**Cloudflare Secrets:**
```
FREECLIMB_ACCOUNT_ID, FREECLIMB_API_KEY, FREECLIMB_SIGNING_SECRET
ANTHROPIC_API_KEY, ADMIN_API_KEY, TTS_SIGNING_SECRET, COGNOS_PUBLIC_KEY
GOOGLE_TTS_API_KEY    # required when TTS_MODE=google
ELEVENLABS_API_KEY    # required when TTS_MODE=11labs
```
**Vars (wrangler.toml):** `TTS_MODE = "google"`
**KV:** `RATE_LIMIT_KV` (id: `58a6ac9954ea44d2972ba2cb9e1e077e`)
**D1:** `DB` → `jc-voxnos` (id: `0998cfff-5efd-4b08-9186-4a3d4f528e98`) — optional, KV fallback if absent
**Service Binding:** `COGNOS` → `jc-cognos` Worker

## Ava Platform Context

Voice node of the Ava platform. Upstream: `jc-cognos` via `POST /brief`. Telephony: FreeClimb. Global constraints: Cloudflare free tier, KV ~30 writes/5-turn call. Full topology: `../platform/mesh/AVA-MAP.md`.

## Debugging & Logs

**"Check recent logs"** → run `./scripts/logs.sh` (most recent call timeline) or `./scripts/logs.sh <callId>`.
- `./scripts/logs.sh --raw` → raw FreeClimb JSON (pipe to `jq`)
- `./scripts/logs.sh --tail` → live Cloudflare Worker `console.log` output via `wrangler tail` (real-time only, ctrl-c to stop)
- Admin API key is read from `.dev.vars`, base URL is `https://jc-voxnos.cloudflare-5cf.workers.dev`
- **FreeClimb logs** (default mode, `GET /logs`): stored by FreeClimb, available after the fact — shows request/response bodies for every webhook exchange. This is the primary debugging tool.
- **Cloudflare Worker logs** (`console.log`): only available live via `--tail` or historically via the Cloudflare dashboard (Workers & Pages → jc-voxnos → Logs). Structured JSON events: `call_incoming`, `conversation_turn`, `pre_filler`, `continue_poll`, `no_input`, `claude_stream_complete`, `tool_execute`, `call_end`
- `rcrdTerminationSilenceTimeMs` max is 3000 (FreeClimb SDK ceiling)

## Deployment

CI/CD: GitHub Actions on push to `master`. Manual: `npx wrangler deploy`. Dev: `npm run dev` + `cloudflared tunnel --url http://localhost:8787`.

## Adding a New App

**LLM assistant** (no code required): `POST /apps/definitions` with `{ id, name, type: "conversational", config: { systemPrompt, greetings[], fillers[], goodbyes[], retries?[], model?, tools?[], voice? } }`. Tools are optional — when omitted, all registered tools are available. When specified (e.g. `["weather", "cognos"]`), only those tools are sent to Claude. `voice` sets the Google TTS voice (e.g. `"en-US-Chirp3-HD-Leda"`); when omitted, the global default (Despina) is used. The app is registered in-memory immediately and persists across deploys via D1. To update, `POST` again with the same `id`. To remove, `DELETE /apps/definitions/:id`.

**Survey** (no code required): `POST /apps/definitions` with `{ id, name, type: "survey", config: { greeting, closing, questions[{label,text,type}], retries?[], voice? } }`. Question types: `yes_no`, `scale`, or `open`. `voice` same as conversational. Same lifecycle as above.

**Phone routing**: `POST /phone-routes` with `{ phone_number, app_id, label? }` to assign a dedicated FreeClimb number to any app.

**Custom**: implement `VoxnosApp` directly from `engine/types` for anything that doesn't fit the above patterns. See `src/apps/echo.ts`. Register in `src/index.ts`: `registry.register(new MyApp())`.

## Mesh Protocol

Update `CLAUDE.md` when behavior or wiring changes. Produce a **Docs Sync Summary**: files changed, what was affected, downstream impact. No secret values. Full protocol: `../platform/mesh/DOCS-SYNC.md`.

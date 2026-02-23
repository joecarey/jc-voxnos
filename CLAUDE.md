# jc-voxnos

Multi-app voice platform: FreeClimb telephony + Claude Sonnet 4.6 + Google Chirp 3 HD TTS.

**Response style**: No code snippets in explanations — describe changes in prose. Show diffs or code only when explicitly asked.

**Call flow**: `/call` → App Router → `app.onStart()` greeting. `/conversation` → Engine `processTurn()` → TurnResult → FreeClimb adapter → PerCL + TTS.

**Source layout**:
- `src/index.ts` — entry point, HTTP router, admin endpoints
- `src/engine/` — conversation engine + app framework (types, engine, base-app, conversational-app, survey-app, registry, speech-utils)
- `src/telephony/` — FreeClimb adapter (routes, percl)
- `src/services/` — shared clients (claude-client, conversation, survey-store)
- `src/platform/` — HTTP infrastructure (auth, webhook-auth, rate-limit, env)
- `src/apps/` — concrete app instances (ava, rita, coco, otto, echo)
- `src/tts/` — TTS providers (google, elevenlabs, freeclimb, helpers, streaming)
- `src/tools/` — tool system (registry, weather, cognos)

## App Type Hierarchy

```
VoxnosApp (interface — platform contract)
├── BaseApp (abstract — logging, KV cleanup)
│   ├── ConversationalApp (LLM turn cycle: Claude + history + streaming)
│   │   ├── Ava, Rita
│   └── SurveyApp (scripted Q&A: sequential questions, typed answer parsing)
│       └── Coco
└── EchoApp (implements VoxnosApp directly)
```

## Registered Apps

- `EchoApp` — demo only, implements VoxnosApp directly
- `OttoAssistant` — dormant snapshot of pre-Ava assistant (2026-02-23); not routed to any FreeClimb number
- `RitaAssistant` — ConversationalApp, neutral/professional personality. Not routed to a phone number.
- `CocoSurvey` — SurveyApp, 3-question CX demo (satisfaction scale, recommend yes/no, open feedback). Not routed to a phone number.
- `AvaAssistant` — **default** — ConversationalApp, Claude Sonnet 4.6, tools (weather + cognos), streaming TTS, KV conversation history. Warm/familiar personality ("Ava"), informal greetings, short fillers, concise goodbyes.

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

### Public
- `GET /` — health check, `GET /apps` — list registered apps

## TTS Configuration

**Active**: `TTS_MODE=google` → `en-US-Chirp3-HD-Despina` (Chirp 3 HD), LINEAR16 WAV 8kHz
**Modes**: `google` (active) | `11labs` (direct ElevenLabs) | `freeclimb` (built-in, always fallback)
**Fallback**: google/11labs failure → FreeClimb built-in Say automatically
**Cache key rule**: stable keys append `voiceSlug(env)` (mode-aware: "despina" for google, "sarah" for 11labs); `/tts-cache` always `Cache-Control: no-store`

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
| `rl:{prefix}:{id}:{bucket}` | count string | 120s | rate limiting |
| `costs:voxnos:{date}` | JSON token counts | 90d | cost tracking |
| `survey:{callId}` | JSON survey state | 15min | in-flight survey progress (question index + answers) |
| `survey-results:{callId}` | JSON results + summary | 24hr | completed survey fallback (when D1 is unavailable) |

## D1 Schema (DB — jc-voxnos-surveys)

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

## Invariants

- Keep FreeClimb webhook signature validation
- Keep per-turn UUID in KV keys — prevents stale cross-turn reads
- Do not weaken rate limiting
- Keep `voiceSlug(env)` appended to all stable TTS cache keys
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
- **`base-app.ts`** — `BaseApp` abstract class implementing `VoxnosApp`. Handles call lifecycle logging (`call_start`/`call_end`), KV cleanup in `onEnd`. Exposes `fillerPhrases` and `retryPhrases`. Subclasses implement `getGreeting()` and `onSpeech()`.
- **`conversational-app.ts`** — `ConversationalApp extends BaseApp`. LLM-conversational pattern: goodbye detection, conversation history, Claude delegation, streaming with filler tagging. Configured via `AssistantConfig` (id, name, systemPrompt, greetings, fillers, goodbyes, retries, model).
- **`survey-app.ts`** — `SurveyApp extends BaseApp`. Scripted Q&A: sequential questions, typed answer parsing, Claude-generated summary. Configured via `SurveyConfig` (id, name, greeting, closing, questions, retries).
- **`registry.ts`** — `AppRegistry` singleton. Maps app IDs to instances, resolves phone numbers to apps.
- **`speech-utils.ts`** — `fetchWithRetry()`, `extractCompleteSentences()`, `isGoodbye()`. Pure functions. `isGoodbye` is the single source of truth (used by engine and apps).

## Services (src/services/)

- **`claude-client.ts`** — `streamClaude(config, context, messages)` async generator, `callClaude(config, context, history)` non-streaming, `trackDailyCost(kv, input, output)`. Parameterized via `ClaudeConfig` (systemPrompt, model, fillerPhrases). Default model: `CLAUDE_MODEL`.
- **`conversation.ts`** — `ContentBlock`/`Message` types, `compressToolResults()`, `getMessages()`, `saveMessages()`. KV conversation history with 15-min TTL.
- **`survey-store.ts`** — D1 data access for persistent survey results. `saveSurveyResult(db, result)`, `listSurveyResults(db, opts)`, `getSurveyResult(db, id)`. Used by SurveyApp (write) and admin endpoints (read).

## Telephony (src/telephony/)

- **`routes.ts`** — FreeClimb adapter. Converts engine `TurnResult` to PerCL + TTS. Handles `/call` and `/conversation` webhooks. If you swapped telephony providers, this directory gets replaced.
- **`percl.ts`** — PerCL command builder. `buildPerCL(response, baseUrl, ttsProvider)` converts `AppResponse` to FreeClimb JSON commands.

## Platform (src/platform/)

- **`auth.ts`** — `requireAdminAuth(request, env)`, Bearer token validation against `ADMIN_API_KEY`.
- **`webhook-auth.ts`** — FreeClimb webhook signature validation.
- **`rate-limit.ts`** — KV-based rate limiting with configurable buckets.
- **`env.ts`** — Environment variable validation on startup.

## TTS Modules (src/tts/)

- **`helpers.ts`** — `voiceSlug(env)`, `greetingCacheKey(text, slug)`, `callTTS(text, env)`, `getTTSProvider(env)`, `sanitizeForTTS(text)`. Shared TTS infrastructure used by routes and streaming.
- **`streaming.ts`** — `processRemainingStream(sentenceStream, callKey, env, startIndex, opts)`. Background KV streaming pipeline for sentence-by-sentence TTS delivery.
- **`google.ts`** — Google Chirp 3 HD TTS client.
- **`elevenlabs.ts`** — ElevenLabs TTS client + HMAC signing.
- **`freeclimb.ts`** — TTSProvider implementations (DirectElevenLabsProvider, FreeClimbDefaultProvider).

Creating a new LLM assistant: extend `ConversationalApp` from `engine/conversational-app`, pass an `AssistantConfig` (~30 lines). Creating a new survey: extend `SurveyApp` from `engine/survey-app`, pass a `SurveyConfig` with questions (~30 lines).

## Recent changes

- **Codebase reorganization**: Replaced monolithic `src/core/` with purpose-aligned directories: `src/engine/` (app framework + turn cycle), `src/services/` (Claude client, conversation, survey store), `src/telephony/` (FreeClimb routes + PerCL), `src/platform/` (auth, rate limiting, env). SurveyApp moved from `apps/survey.ts` to `engine/survey-app.ts`. `sanitizeForTTS` moved from percl to `tts/helpers.ts`. Old `src/core/` and `src/percl/` directories removed.
- **Phase 4 survey back-end (D1)**: Added `jc-voxnos-surveys` D1 database with `survey_results` table. SurveyApp writes to D1 on completion (KV fallback if D1 unavailable). New data access module `src/services/survey-store.ts`. Admin endpoints: `GET /survey-results` (list with filters) and `GET /survey-results/:id` (detail). `DB?: D1Database` added to Env as optional binding.
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
- No change to tool definitions, external contracts, KV patterns, or D1 schema. Keep `COGNOS_PUBLIC_KEY` and `COGNOS` Service Binding present in env.

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
**D1:** `DB` → `jc-voxnos-surveys` (id: `131ed879-edf4-414c-83c7-c76fa5ede37c`) — optional, KV fallback if absent
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

**LLM assistant** (~30 lines): extend `ConversationalApp` from `engine/conversational-app`, pass `AssistantConfig` (id, name, systemPrompt, greetings, fillers, goodbyes, retries). See `src/apps/ava.ts` or `src/apps/rita.ts`.

**Survey/scripted flow** (~30 lines): extend `SurveyApp` from `engine/survey-app`, pass `SurveyConfig` (id, name, greeting, closing, questions, retries). See `src/apps/coco.ts`.

**Custom**: implement `VoxnosApp` directly from `engine/types` for anything that doesn't fit the above patterns. See `src/apps/echo.ts`.

Register in `src/index.ts`: `registry.register(new MyApp())` — pass `true` as second arg for default.

## Mesh Protocol

Update `CLAUDE.md` when behavior or wiring changes. Produce a **Docs Sync Summary**: files changed, what was affected, downstream impact. No secret values. Full protocol: `../platform/mesh/DOCS-SYNC.md`.

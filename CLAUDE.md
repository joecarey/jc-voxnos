# voxnos

Multi-app voice platform: FreeClimb telephony + Claude Sonnet 4.6 + Google Chirp 3 HD TTS.

**Response style**: No code snippets in explanations — describe changes in prose. Show diffs or code only when explicitly asked.

**Call flow**: `/call` → allowlist check → App Router → `app.onStart()` greeting. `/conversation` → Engine `processTurn()` → TurnResult → FreeClimb adapter → PerCL + TTS.

**Source layout**:
- `src/index.ts` — entry point, env validation, isolate setup, HTTP routing table, OAuthProvider wrapper
- `src/mcp-server.ts` — MCP server factory with 18 tools (observability, FreeClimb, D1, allowlist)
- `src/auth-handler.ts` — OAuth authorize flow + REST API delegation
- `src/admin/` — admin endpoint handlers (`routes.ts` with `registerAppFromDefinition`, `validation.ts`, `helpers.ts` with `requireAdmin`)
- `src/engine/` — conversation engine + app framework (`types.ts` Env/VoxnosApp, `engine.ts` processTurn/TurnResult, `base-app.ts`, `conversational-app.ts`, `survey-app.ts`, `registry.ts`, `speech-utils.ts`)
- `src/telephony/` — FreeClimb adapter (`routes.ts` webhook→PerCL, `percl.ts` builder, `freeclimb-admin.ts` API wrappers)
- `src/services/` — data access + clients (`claude-client.ts`, `conversation.ts` KV history, `app-store.ts` D1 CRUD + normalizeE164, `cdr-store.ts`, `survey-store.ts`, `caller-allowlist.ts` in-memory allowlist)
- `src/platform/` — HTTP infrastructure (`auth.ts`, `webhook-auth.ts`, `rate-limit.ts`, `env.ts`)
- `src/apps/` — code-defined fallback apps (ava, rita, echo)
- `src/tts/` — TTS providers (`helpers.ts` voiceSlug/callTTS/sanitize, `streaming.ts` KV pipeline, `google.ts`, `elevenlabs.ts`, `freeclimb.ts`)
- `src/tools/` — tool system (`registry.ts`, `weather.ts`, `cognos.ts`, `transfer.ts`)

## App Type Hierarchy

```
VoxnosApp (interface — platform contract)
├── BaseApp (abstract — logging, KV cleanup)
│   ├── ConversationalApp (LLM turn cycle: Claude + history + streaming)
│   │   └── (D1-driven — Ava, Rita, River, etc.)
│   └── SurveyApp (scripted Q&A: sequential questions, typed answer parsing)
│       └── (D1-driven — Coco, etc.)
└── EchoApp (implements VoxnosApp directly)
```

Apps and phone routes are D1-driven and discoverable via MCP tools (`apps`, `phone_routes`). Fallback: if D1 is unavailable at startup, code-defined AvaAssistant and RitaAssistant are registered instead.

## MCP Server

18 tools at `/mcp`, OAuth 2.1 (same pattern as cognos/memnos). `createServer(env)` in `src/mcp-server.ts`.

Observability: `health`, `costs`, `account`. FreeClimb: `numbers`, `available_numbers`, `logs`, `buy_number`, `route_number`. D1: `apps`, `phone_routes`, `calls`, `call_detail`, `surveys`. Allowlist: `allowed_callers`, `allow_caller`, `block_caller`, `enable_allowlist`, `disable_allowlist`.

FreeClimb tools use exported `freeclimbAuth()` from `telephony/freeclimb-admin.ts` for direct API calls. D1 tools import from `services/app-store.ts`, `services/cdr-store.ts`, `services/survey-store.ts`.

## Caller Allowlist

Per-inbound-number caller filtering in `src/services/caller-allowlist.ts`. Checked at the `/call` endpoint in `index.ts` before routing.

- D1 tables: `allowed_callers` (composite PK `inbound_number, caller_number`), `allowlist_enabled` (PK `inbound_number`)
- In-memory: `Map<inbound, Set<caller>>` + `Set<enabled_inbound>`, loaded from D1 at startup via `reloadAllowedCallers(db)`
- `isCallerAllowed(inbound, caller)`: enforcement off → allow; enforcement on + no entries → block all; enforcement on + entries → must be listed
- `normalizeE164()` in `app-store.ts` handles 10-digit, 11-digit, +1 formats; returns null for invalid
- Fail-closed: unparseable numbers or missing entries → reject via FreeClimb `Reject` PerCL

## Internal Call Transfer

`transfer_to_app` tool writes KV keys: `call-app:{callId}` (durable app override), `call-app:{callId}:pending` (one-shot flag), optionally `call-transfer-context:{callId}` (warm transfer intent). Two-key design avoids KV eventual-consistency races.

**Cold transfer**: target app's `onStart()` called. **Warm transfer** (intent + ConversationalApp target): skips `onStart()`, injects intent as synthetic first message.

## TTS Configuration

**Active**: `TTS_MODE=google` → Google Chirp 3 HD, LINEAR16 WAV 8kHz
**Per-app voices**: `config.voice` in app definition (e.g. `en-US-Chirp3-HD-Aoede`). Default: Despina.
**Fallback chain**: Google/ElevenLabs failure → FreeClimb built-in Say

## Streaming Flow

1. `streamSpeech()` yields sentences from Claude's streaming response
2. **Pre-filler** (50% chance, non-goodbye): cached filler played immediately, full stream in background
3. First sentence TTS'd → KV → `Play` + `Redirect` to `/continue`
4. Remaining: background via `ctx.waitUntil()`, stored in KV with per-turn UUID
5. `/continue` polls KV (25×500ms, ~12.5s max) → `Play+Redirect`, `Play+Pause+Hangup`, or `TranscribeUtterance`
6. Hangup-via-KV: `processRemainingStream` writes `{callKey}:hangup` marker

## KV Schema (RATE_LIMIT_KV)

| Key pattern | Value | TTL | Purpose |
|---|---|---|---|
| `tts:{stable-key}-{VOICE_SLUG}` | audio ArrayBuffer | 6hr | greetings, fillers, retry phrases |
| `tts:{uuid}` | audio ArrayBuffer | 120s | per-sentence streaming audio |
| `stream:{callId}:{turnId}:{n}` | UUID string | 120s | sentence index pointer |
| `stream:{callId}:{turnId}:pending` | `'1'` | 120s | stream-alive signal |
| `stream:{callId}:{turnId}:done` | `'1'` | 120s | stream completion signal |
| `stream:{callId}:{turnId}:hangup` | sentence index | 120s | hangup marker |
| `conv:{callId}` | JSON messages | 15min | conversation history |
| `call-app:{callId}` | app ID | 15min | transfer app override |
| `call-app:{callId}:pending` | `'1'` | 15min | transfer greeting flag |
| `call-transfer-context:{callId}` | JSON `{intent}` | 15min | warm transfer context |
| `rl:{prefix}:{id}:{bucket}` | count | 120s | rate limiting |
| `costs:voxnos:{date}` | JSON tokens | 90d | cost tracking |

## Invariants

- Keep FreeClimb webhook signature validation
- Keep per-turn UUID in KV keys — prevents stale cross-turn reads
- Do not weaken rate limiting
- Keep `voiceSlug(env, voice)` appended to all stable TTS cache keys
- Keep `Cache-Control: no-store` on all `/tts-cache` responses
- Pre-filler path must skip app-yielded fillers (`skipFillers`)
- `processRemainingStream` must write `:pending` on entry, hangup marker on hangup chunks
- Caller allowlist check must remain in `index.ts` before `handleIncomingCall` (not in routes.ts — avoids circular import)

## Cognos Dependency

Calls `POST /brief` via Cloudflare Service Binding (`env.COGNOS`) — internal routing, no public URL.
- Auth: `COGNOS_PUBLIC_KEY` Bearer token
- Request: `{q, voice_mode: true, voice_detail: 1–5}`
- Response: `answer` field (speakable text, no URLs/citations)
- **Stability rule**: if cognos changes this contract, update this section.

## Environment

**Cloudflare Secrets:**
```
FREECLIMB_ACCOUNT_ID, FREECLIMB_API_KEY, FREECLIMB_SIGNING_SECRET
ANTHROPIC_API_KEY, ADMIN_API_KEY, TTS_SIGNING_SECRET, COGNOS_PUBLIC_KEY
GOOGLE_TTS_API_KEY, AUTH_PASSWORD, MCP_API_KEY
```
**Vars (wrangler.toml):** `TTS_MODE = "google"`
**KV:** `RATE_LIMIT_KV` (rate limiting + costs + TTS + conversation), `OAUTH_KV` (MCP OAuth tokens)
**D1:** `DB` → `voxnos` (apps, routes, CDR, surveys, allowlist)
**Service Binding:** `COGNOS` → `cognos` Worker

## Deployment

CI/CD: GitHub Actions on push to `master`. Manual: `npx wrangler deploy`. Dev: `npm run dev` + `cloudflared tunnel --url http://localhost:8787`.

## Adding a New App

**LLM assistant** (no code): `POST /apps/definitions` with `{ id, name, type: "conversational", config: { systemPrompt, greetings[], fillers[], goodbyes[], retries?[], model?, tools?[], voice? } }`. `tools` filters which tools are sent to Claude. `voice` sets Google TTS voice. Registered in-memory immediately, persists via D1.

**Survey** (no code): `POST /apps/definitions` with `{ id, name, type: "survey", config: { greeting, closing, questions[{label,text,type}], retries?[], voice? } }`. Question types: `yes_no`, `scale`, `open`.

**Custom**: implement `VoxnosApp` from `engine/types`. See `src/apps/echo.ts`.

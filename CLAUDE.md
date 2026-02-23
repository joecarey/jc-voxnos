# jc-voxnos

Multi-app voice platform: FreeClimb telephony + Claude Sonnet 4.6 + Google Chirp 3 HD TTS.

**Response style**: No code snippets in explanations — describe changes in prose. Show diffs or code only when explicitly asked.

**Call flow**: `/call` → App Router → `app.onStart()` greeting. `/conversation` → `app.onSpeech()` → Claude + tools → `streamSpeech()` → KV → Play commands.

**Source**: `src/index.ts` (routing, /tts /tts-cache /continue), `src/routes.ts` (handleConversation, streaming V2, pre-filler), `src/apps/ava.ts` (default app), `src/apps/otto.ts` (dormant snapshot), `src/tools/` (weather, cognos), `src/tts/` (google, elevenlabs, freeclimb providers), `src/percl/builder.ts`, `src/core/` (types, registry, auth, webhook-auth, rate-limit, env).

## Registered Apps

- `EchoApp` — demo only
- `OttoAssistant` — dormant snapshot of pre-Ava assistant (2026-02-23); not routed to any FreeClimb number
- `AvaAssistant` — **default** — Claude Sonnet 4.6 (`claude-sonnet-4-6`), tools (weather + cognos), streaming TTS, KV conversation history. Warm/familiar personality ("Ava"), informal greetings, short fillers, concise goodbyes.

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

## Recent changes

- **Ava rebrand**: `ClaudeAssistant` → `AvaAssistant` (`src/apps/ava.ts`). Named system prompt ("You are Ava"), informal greetings (random, no time-of-day), short fillers, warm goodbyes.
- **Otto snapshot**: `OttoAssistant` (`src/apps/otto.ts`) — frozen copy of pre-Ava assistant with original personality. Dormant (no FreeClimb number).
- **Pre-filler acknowledgments**: route layer plays a cached filler immediately on 50% of non-goodbye turns (`PRE_FILLER_PROBABILITY`). Fills dead air during Anthropic API TTFB. `VoxnosApp.fillerPhrases` lets each app declare its own set.
- **Hangup-via-KV marker**: `processRemainingStream` writes `{callKey}:hangup` when it encounters a hangup chunk. `/continue` checks this and returns Play+Pause+Hangup. Covers edge cases where goodbye detection at the route layer has a false negative.
- **Cognos Service Binding**: `env.COGNOS` Fetcher replaces public workers.dev URL — eliminates same-account edge routing 404s.
- **Tool result compression**: `compressToolResults()` truncates tool_result blocks >120 chars before saving to KV, keeping token count bounded across multi-turn calls.
- `/continue` poll window increased from 15 to 25 attempts (~12.5s max).
- Removed dead code: `/transfer`, `OutDial`, unused rate limit configs, `@supabase/supabase-js`.

Downstream impact:
- New KV key pattern: `stream:{callId}:{turnId}:hangup`. No change to tool definitions. Keep `COGNOS_PUBLIC_KEY` and `COGNOS` Service Binding present in env.

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
**Service Binding:** `COGNOS` → `jc-cognos` Worker

## Ava Platform Context

Voice node of the Ava platform. Upstream: `jc-cognos` via `POST /brief`. Telephony: FreeClimb. Global constraints: Cloudflare free tier, KV ~30 writes/5-turn call. Full topology: `../platform/mesh/AVA-MAP.md`.

## Debugging & Logs

**"Check recent logs"** → run `./scripts/logs.sh` (most recent call timeline) or `./scripts/logs.sh <callId>`.
- `./scripts/logs.sh --raw` → raw FreeClimb JSON (pipe to `jq`)
- `./scripts/logs.sh --tail` → live Cloudflare Worker `console.log` output (ctrl-c to stop)
- Admin API key is read from `.dev.vars`, base URL is `https://jc-voxnos.cloudflare-5cf.workers.dev`
- Worker logs (`console.log`) emit structured JSON events: `call_incoming`, `conversation_turn`, `pre_filler`, `continue_poll`, `no_input`, `claude_stream_complete`, `tool_execute`, `call_end`
- FreeClimb logs (via `GET /logs`) show request/response bodies for every webhook exchange
- `rcrdTerminationSilenceTimeMs` max is 3000 (FreeClimb SDK ceiling)

## Deployment

CI/CD: GitHub Actions on push to `master`. Manual: `npx wrangler deploy`. Dev: `npm run dev` + `cloudflared tunnel --url http://localhost:8787`.

## Adding a New App

1. Create `src/apps/my-app.ts` implementing `VoxnosApp` (`onStart`, `onSpeech`, optional `onEnd`, optional `streamSpeech`, optional `fillerPhrases`)
2. Register in `src/index.ts`: `registry.register(new MyApp())` — pass `true` as second arg for default

## Mesh Protocol

Update `CLAUDE.md` when behavior or wiring changes. Produce a **Docs Sync Summary**: files changed, what was affected, downstream impact. No secret values. Full protocol: `../platform/mesh/DOCS-SYNC.md`.

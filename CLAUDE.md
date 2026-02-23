# jc-voxnos

Multi-app voice platform: FreeClimb telephony + Claude Sonnet 4.6 + Google Chirp 3 HD TTS.

**Call flow**: `/call` → App Router → `app.onStart()` greeting. `/conversation` → `app.onSpeech()` → Claude + tools → `streamSpeech()` → KV → Play commands.

**Source**: `src/index.ts` (routing, /tts /tts-cache /continue), `src/routes.ts` (handleConversation, streaming V2), `src/apps/claude-assistant.ts` (default app), `src/tools/` (weather, cognos), `src/tts/` (google, elevenlabs, freeclimb providers), `src/percl/builder.ts`, `src/core/` (types, registry, auth, webhook-auth, rate-limit, env).

## Registered Apps

- `EchoApp` — demo only
- `ClaudeAssistant` — **default** — Claude Sonnet 4.6 (`claude-sonnet-4-6`), tools (weather + cognos), streaming TTS, KV conversation history

## HTTP Endpoints

### FreeClimb Webhooks (FREECLIMB_SIGNING_SECRET validated)
- `POST /call` — incoming call, returns PerCL greeting + TranscribeUtterance
- `POST /conversation` — each speech turn, returns PerCL response

### TTS (public, HMAC-signed URLs)
- `GET /tts` — on-demand: `?text=...&sig=...` — validates HMAC, calls Google/ElevenLabs, returns audio
- `GET /tts-cache` — KV-backed: `?id=...` — serves pre-generated audio, `Cache-Control: no-store`
- `GET /continue` — streaming chain: polls KV for next sentence (15×500ms), returns Play+Redirect or TranscribeUtterance

### Admin (Bearer: ADMIN_API_KEY)
- `GET /debug/account`, `GET /phone-numbers`, `POST /setup`, `POST /update-number`, `POST /update-app`
- `GET /logs` — FreeClimb call logs, `GET /costs` — 14-day Anthropic token usage

### Public
- `GET /` — health check, `GET /apps` — list registered apps

## TTS Configuration

**Active**: `TTS_MODE=google` → `en-US-Chirp3-HD-Despina` (Chirp 3 HD), LINEAR16 WAV 8kHz
**Modes**: `google` (active) | `11labs` (direct ElevenLabs) | `freeclimb` (built-in, always fallback)
**Fallback**: google/11labs failure → FreeClimb built-in Say automatically
**Cache key rule**: stable keys append `VOICE_SLUG`; `/tts-cache` always `Cache-Control: no-store`

## Streaming Flow (TTS_MODE=google|11labs)

1. `streamSpeech()` yields sentences from Claude's streaming response
2. First sentence: TTS'd immediately → KV → `Play` + `Redirect` to `/continue`
3. Remaining: background via `ctx.waitUntil()`, stored in KV with per-turn UUID
4. `/continue` polls KV (15×500ms, ~7.5s max) → `Play+Redirect` or `TranscribeUtterance`

## KV Schema (RATE_LIMIT_KV)

| Key pattern | Value | TTL | Purpose |
|---|---|---|---|
| `tts:{stable-key}-{VOICE_SLUG}` | audio ArrayBuffer | 6hr | greetings, fillers, retry phrases |
| `tts:{uuid}` | audio ArrayBuffer | 120s | per-sentence streaming audio |
| `stream:{callId}:{turnId}:{n}` | UUID string | 120s | sentence index pointer |
| `stream:{callId}:{turnId}:done` | `'1'` | 120s | stream completion signal |
| `conv:{callId}` | JSON messages | 15min | conversation history |
| `rl:{prefix}:{id}:{bucket}` | count string | 120s | rate limiting |
| `costs:voxnos:{date}` | JSON token counts | 90d | cost tracking |

## Invariants

- Keep FreeClimb webhook signature validation
- Keep per-turn UUID in KV keys — prevents stale cross-turn reads
- Do not weaken rate limiting
- Keep `VOICE_SLUG` appended to all stable TTS cache keys
- Keep `Cache-Control: no-store` on all `/tts-cache` responses

## Cognos Dependency

Calls `POST https://jc-cognos.cloudflare-5cf.workers.dev/brief` via the `cognos` tool.

- Auth: `COGNOS_PUBLIC_KEY` Bearer token
- Request: `{q, voice_mode: true, voice_detail: 1–5}`
- Response: `answer` field (speakable text, no URLs/citations)
- **Stability rule**: if cognos changes this contract, update this section.

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

## Ava Platform Context

Voice node of the Ava platform. Upstream: `jc-cognos` via `POST /brief`. Telephony: FreeClimb. Global constraints: Cloudflare free tier, KV ~30 writes/5-turn call. Full topology: `../platform/mesh/AVA-MAP.md`.

## Deployment

CI/CD: GitHub Actions on push to `master`. Manual: `npx wrangler deploy`. Dev: `npm run dev` + `cloudflared tunnel --url http://localhost:8787`.

## Adding a New App

1. Create `src/apps/my-app.ts` implementing `VoxnosApp` (`onStart`, `onSpeech`, optional `onEnd`, optional `streamSpeech`)
2. Register in `src/index.ts`: `registry.register(new MyApp())` — pass `true` as second arg for default

## Mesh Protocol

Update `CLAUDE.md` when behavior or wiring changes. Produce a **Docs Sync Summary**: files changed, what was affected, downstream impact. No secret values. Full protocol: `../platform/mesh/DOCS-SYNC.md`.

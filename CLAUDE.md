# jc-voxnos

Multi-app voice platform for building speech-enabled applications using FreeClimb telephony. Handles inbound phone calls, routes to registered apps, orchestrates Claude AI + tools, and delivers speech via Google Chirp 3 HD TTS.

## Architecture

```
Incoming Call → FreeClimb → POST /call (webhook-auth)
                                  ↓
                             App Router (registry)
                                  ↓
                          app.onStart() → PerCL response
                                  ↓
Caller speaks → FreeClimb → POST /conversation (webhook-auth)
                                  ↓
                          app.onSpeech() → Claude + tools
                                  ↓
                    streamSpeech() → sentences → KV → Play commands
```

## File Structure

```
src/
├── index.ts              # Entry point, routing, /tts /tts-cache /continue endpoints
├── routes.ts             # handleConversation, V2 streaming orchestration
├── core/
│   ├── types.ts          # VoxnosApp, AppContext, SpeechInput, AppResponse, StreamChunk, Env
│   ├── registry.ts       # App registration and routing
│   ├── auth.ts           # Admin API key auth
│   ├── webhook-auth.ts   # FreeClimb webhook signature validation
│   ├── rate-limit.ts     # KV-backed rate limiting
│   ├── validation.ts     # Input validation
│   └── env.ts            # Env validation
├── apps/
│   ├── claude-assistant.ts  # Default: Claude Sonnet + tools + streamSpeech generator
│   └── echo.ts              # Demo: repeats input
├── tools/
│   ├── types.ts / registry.ts / validation.ts
│   ├── weather.ts        # Open-Meteo API
│   └── cognos.ts         # Cognos /brief integration
├── percl/
│   └── builder.ts        # Async PerCL builder (Say/Play/Hangup/Pause)
└── tts/
    ├── types.ts           # TTSProvider interface (getEngineConfig, optional getPlayUrl)
    ├── elevenlabs.ts      # callElevenLabs(), computeTtsSignature(), ELEVENLABS_VOICE_ID
    ├── freeclimb.ts       # DirectElevenLabsProvider + legacy providers
    ├── google.ts          # callGoogleTTS(), GOOGLE_TTS_VOICE (en-US-Chirp3-HD-Despina)
    └── index.ts           # Provider selection, exports
```

## Registered Apps

- `EchoApp` — demo only
- `ClaudeAssistant` — **default** — Claude Sonnet, tools (weather + cognos), streaming TTS, KV conversation history

## HTTP Endpoints

### FreeClimb Webhooks (FREECLIMB_SIGNING_SECRET validated)
- `POST /call` — incoming call, returns PerCL greeting + TranscribeUtterance
- `POST /conversation` — each speech turn, returns PerCL response

### TTS (public, HMAC-signed URLs)
- `GET /tts` — on-demand TTS: `?text=...&voice=...&sig=...` — validates HMAC, calls Google/ElevenLabs, returns audio
- `GET /tts-cache` — KV-backed audio: `?id=...` — serves pre-generated audio, `Cache-Control: no-store`
- `GET /continue` — streaming redirect chain: polls KV for next sentence (15×500ms), returns Play+Redirect or TranscribeUtterance

### Admin (Bearer: ADMIN_API_KEY)
- `GET /debug/account`, `GET /phone-numbers`, `POST /setup`, `POST /update-number`, `POST /update-app`
- `GET /logs` — FreeClimb call logs (`?limit=N`)
- `GET /costs` — 14-day Anthropic token usage

### Public (no auth)
- `GET /` — health check
- `GET /apps` — list registered apps

## TTS Configuration

**Active mode**: `TTS_MODE=google` (wrangler.toml var)
**Active voice**: `en-US-Chirp3-HD-Despina` (Google Chirp 3 HD)
**Audio format**: LINEAR16 WAV at 8kHz (FreeClimb compatible)

Modes: `google` (active) | `11labs` (direct ElevenLabs) | `freeclimb` (legacy)

**Cache key rule**: All stable TTS keys (filler, goodbye, retry, greeting) append `VOICE_SLUG` — changing voice automatically busts FreeClimb's HTTP cache. All `/tts-cache` responses include `Cache-Control: no-store` to prevent FreeClimb caching at the HTTP layer.

## Streaming Flow (TTS_MODE=google|11labs)

1. `streamSpeech()` yields `StreamChunk` sentences from Claude's streaming response
2. First sentence: pre-generated immediately, stored in KV, returned as `Play` + `Redirect` to `/continue`
3. Remaining sentences: background-processed via `ctx.waitUntil()`, stored in KV with per-turn UUID
4. `/continue` polls KV (15×500ms, ~7.5s max) for next sentence; returns `Play+Redirect` or `TranscribeUtterance` when done

## Conversation History

Stored in KV (`conv:{callId}`, 15-min TTL) — survives Worker isolate routing across turns within a call.

## Rate Limiting

- `/call`: by IP
- `/conversation`: by callId
- Admin endpoints: by API key prefix

## Authentication

- Webhooks: FreeClimb signature header (`FREECLIMB_SIGNING_SECRET`)
- Admin: Bearer token (`ADMIN_API_KEY`)
- TTS URLs: HMAC-SHA256 signature (`TTS_SIGNING_SECRET`)

## Environment

**Cloudflare Secrets:**
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
FREECLIMB_ACCOUNT_ID, FREECLIMB_API_KEY, FREECLIMB_SIGNING_SECRET
ANTHROPIC_API_KEY
ADMIN_API_KEY
ELEVENLABS_API_KEY
TTS_SIGNING_SECRET
COGNOS_PUBLIC_KEY
```

**Vars (wrangler.toml):**
```
TTS_MODE = "google"
```

**KV:** `RATE_LIMIT_KV` (id: `58a6ac9954ea44d2972ba2cb9e1e077e`) — rate limiting + TTS cache + conversation history

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

## Ava Platform Context

This is the **voice node** of the Ava platform.

- **Upstream dependency**: `jc-cognos` — provides knowledge via `POST /brief`
- **Telephony layer**: FreeClimb (call routing, transcription, audio playback)
- Global constraints: Cloudflare free tier, KV 1k writes/day — TTS cache uses ~1 write per sentence; see `platform/CLAUDE.md`
- Full topology: `platform/mesh/AVA-MAP.md`

## Deployment

CI/CD: GitHub Actions auto-deploys on push to `master` (`.github/workflows/deploy.yml`).
Manual: `npx wrangler deploy`
Dev: `npm run dev` + `cloudflared tunnel --url http://localhost:8787`

## Adding a New App

1. Create `src/apps/my-app.ts` implementing `VoxnosApp` (`onStart`, `onSpeech`, optional `onEnd`, optional `streamSpeech`)
2. Register in `src/index.ts`: `registry.register(new MyApp())` — pass `true` as second arg for default

## Mesh Protocol

When you change code or config that affects behavior or wiring, update this file (`CLAUDE.md`) before finishing.

Produce a **Docs Sync Summary**: files changed, what was affected, any downstream impact.

Never include secret values in docs. Full protocol: `platform/mesh/DOCS-SYNC.md`.

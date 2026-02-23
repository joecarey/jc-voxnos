# jc-voxnos

> **Part of the [Ava platform](https://github.com/joecarey/platform)** | See [Platform Overview](https://github.com/joecarey/platform/blob/main/docs/PLATFORM-OVERVIEW.md)

Multi-app voice platform for building speech-enabled applications using FreeClimb telephony and Claude AI.

## What It Does

Voxnos handles inbound phone calls. Each call routes to a registered **app** that controls the conversation. The platform provides shared infrastructure: FreeClimb webhook auth, Claude orchestration, tool execution, and TTS synthesis.

**Default app**: Claude assistant with weather and knowledge base (cognos) tools, streaming Google Chirp 3 HD TTS.

## Architecture

```
Phone Call → FreeClimb → POST /call
                              ↓
                         App Router
                              ↓
                    app.onStart() / app.onSpeech()
                              ↓
                    Claude + Tools → streamSpeech()
                              ↓
                    Google TTS → KV → Play commands
```

## Building an App

Implement `VoxnosApp` and register it:

```typescript
import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from './core/types.js';

export class MyApp implements VoxnosApp {
  id = 'my-app';
  name = 'My Voice App';

  async onStart(context: AppContext): Promise<AppResponse> {
    return { speech: { text: 'Welcome!' }, prompt: true };
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    return { speech: { text: `You said: ${input.text}` }, prompt: true };
  }
}
```

Register in `src/index.ts`:
```typescript
registry.register(new MyApp(), true); // true = default app
```

## Stack

- **Cloudflare Workers** — serverless hosting
- **FreeClimb** — telephony (call routing, transcription, audio playback)
- **Anthropic Claude** — AI assistant (Claude Sonnet)
- **Google Chirp 3 HD** — TTS (`en-US-Chirp3-HD-Despina`)
- **Supabase** — conversation history storage

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /call` | FreeClimb sig | Incoming call webhook |
| `POST /conversation` | FreeClimb sig | Each speech turn |
| `GET /tts` | HMAC sig | On-demand TTS synthesis |
| `GET /tts-cache` | none | Pre-generated audio (KV-backed) |
| `GET /continue` | none | Streaming sentence redirect chain |
| `GET /` | none | Health check |
| `GET /apps` | none | List registered apps |
| `GET /logs` | admin | FreeClimb call logs |
| `GET /costs` | admin | 14-day Anthropic token usage |

## Development

```bash
npm install
npm run dev
cloudflared tunnel --url http://localhost:8787
```

Update FreeClimb phone number voice URL to the tunnel URL.

## Deploy

```bash
npm run deploy  # or: npx wrangler deploy
```

CI/CD: GitHub Actions auto-deploys on push to `master`.

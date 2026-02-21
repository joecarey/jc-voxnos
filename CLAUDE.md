# jc-voxnos

Platform for building speech-enabled voice applications using FreeClimb telephony.

## Core Concept

Voxnos is a **multi-app voice platform** — not a single IVR. Multiple voice apps can be registered and routed by phone number. Each app implements its own conversation logic. The platform provides shared infrastructure: auth, rate limiting, tools, TTS, and PerCL command generation.

## Architecture

```
Incoming Call → FreeClimb → POST /call (webhook-authenticated)
                                  ↓
                             App Router (registry)
                                  ↓
                          app.onStart() → PerCL response
                                  ↓
Caller speaks → FreeClimb → POST /conversation (webhook-authenticated)
                                  ↓
                          app.onSpeech()
                          [ClaudeAssistant: Claude API + tools]
                                  ↓
                          PerCL response → FreeClimb plays TTS
```

## File Structure

```
src/
├── index.ts              # Entry point, routing, auth, rate limiting
├── routes.ts             # Route handler implementations
├── core/
│   ├── types.ts          # VoxnosApp interface, AppContext, SpeechInput, AppResponse, Env
│   ├── registry.ts       # App registration and routing (default app support)
│   ├── auth.ts           # Admin API key auth (requireAdminAuth)
│   ├── webhook-auth.ts   # FreeClimb webhook signature validation
│   ├── rate-limit.ts     # KV-backed rate limiting (call, conversation, admin)
│   ├── validation.ts     # Input validation helpers
│   └── env.ts            # Env validation and setup instructions
├── apps/
│   ├── claude-assistant.ts  # Default app: Claude-powered conversational AI
│   └── echo.ts              # Demo app: repeats caller input
├── tools/
│   ├── types.ts          # VoxnosTool interface
│   ├── registry.ts       # Tool registration
│   ├── validation.ts     # Tool call validation
│   ├── weather.ts        # Weather tool (Open-Meteo API)
│   └── cognos.ts         # Cognos knowledge base tool (/brief integration)
├── percl/
│   └── builder.ts        # PerCL command builder (Say, RecordUtterance, Hangup)
└── tts/
    ├── types.ts           # TTS types
    ├── freeclimb.ts       # FreeClimb TTS via Say PerCL command
    └── index.ts           # TTS provider selection
```

## Registered Apps

```typescript
registry.register(new EchoApp());                // Demo only
registry.register(new ClaudeAssistant(), true);  // DEFAULT — all calls route here
```

**ClaudeAssistant** (default app):
- Maintains conversation history per call via in-memory state
- Uses Claude Sonnet for natural language understanding
- Has access to registered tools (weather, cognos)
- Greets caller and listens for voice input each turn
- Gracefully handles low-confidence transcription

## Tools System

Tools extend ClaudeAssistant's capabilities as Claude tool_use function calls:

| Tool | What it does |
|------|-------------|
| `weather` | Current conditions + forecast via Open-Meteo API |
| `cognos` | Queries the cognos knowledge base via `/brief` endpoint |

Tools implement `VoxnosTool` interface: `name`, `description`, `parameters`, `execute()`.

## HTTP Endpoints

### Webhooks (FreeClimb-authenticated via signature)
- `POST /call` — incoming call, returns PerCL greeting + RecordUtterance
- `POST /conversation` — each speech turn, returns PerCL response

### Public (no auth)
- `GET /` — health check
- `GET /apps` — list registered apps

### Admin (Bearer token: `ADMIN_API_KEY`)
- `GET /debug/account` — FreeClimb account info
- `GET /phone-numbers` — list FreeClimb phone numbers
- `POST /setup` — configure FreeClimb app + phone number webhook URLs
- `POST /update-number` — update phone number alias
- `POST /update-app` — update FreeClimb application webhook URLs
- `GET /logs` — FreeClimb call logs (supports `?limit=N`)
- `GET /costs` — 14-day Anthropic token usage summary

## Rate Limiting

All rate limits are KV-backed (`RATE_LIMIT_KV`):
- **Call start** (`/call`): limited by IP — prevents flood attacks
- **Conversation turns** (`/conversation`): limited by `callId` — prevents runaway loops
- **Admin** (`/debug/account`, `/phone-numbers`, etc.): limited by API key prefix

## Authentication

- **FreeClimb webhooks** (`/call`, `/conversation`): validated via FreeClimb signature header (using `FREECLIMB_API_KEY`)
- **Admin endpoints**: Bearer token (`ADMIN_API_KEY`)
- **Public endpoints** (`/`, `/apps`): no auth

## Environment Variables (Cloudflare Secrets)

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
FREECLIMB_ACCOUNT_ID
FREECLIMB_API_KEY
ANTHROPIC_API_KEY
ADMIN_API_KEY          # Admin bearer token
```

KV namespace (set in wrangler.toml):
- `RATE_LIMIT_KV` — rate limiting + cost tracking

## Deployment

**CI/CD**: GitHub Actions auto-deploys on push to `master` (`.github/workflows/deploy.yml`)

```bash
# Manual override
npx wrangler deploy
```

## Development

Local dev requires a public URL for FreeClimb webhooks:

```bash
npm run dev  # Start on localhost:8787
cloudflared tunnel --url http://localhost:8787
```

Update FreeClimb phone number voice URL to the tunnel URL (use `/setup` endpoint or FreeClimb dashboard).

## Adding a New App

1. Create `src/apps/my-app.ts` implementing `VoxnosApp`:

```typescript
import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from '../core/types.js';

export class MyApp implements VoxnosApp {
  id = 'my-app';
  name = 'My App';

  async onStart(context: AppContext): Promise<AppResponse> {
    return { speech: { text: 'Welcome!' }, prompt: true };
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    return { speech: { text: `You said: ${input.text}` }, prompt: true };
  }
}
```

2. Register in `src/index.ts`:

```typescript
import { MyApp } from './apps/my-app.js';
registry.register(new MyApp());  // Pass true as second arg to make it the default
```

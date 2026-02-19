# jc-voxnos

Platform for building speech-enabled voice applications using FreeClimb API.

## Core Concept

Voxnos is **not a single IVR** - it's a **platform** for building multiple speech-enabled voice apps. Each app can implement its own conversation logic, integrate with external services (like Claude API), and access shared resources (database, sessions, etc.).

## Architecture

```
Incoming Call → FreeClimb → /voice webhook
                               ↓
                          App Router
                               ↓
                     Get app for phone number
                               ↓
                          app.onStart()
                               ↓
                     Return PerCL (Say + RecordUtterance)
                               ↓
Caller speaks → FreeClimb transcribes → /transcription webhook
                                              ↓
                                         app.onSpeech()
                                              ↓
                                    Return PerCL (response)
```

## App Interface

All apps implement `VoxnosApp`:

```typescript
interface VoxnosApp {
  id: string;        // Unique identifier
  name: string;      // Display name

  // Lifecycle methods
  onStart(context: AppContext): Promise<AppResponse>;
  onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse>;
  onEnd?(context: AppContext): Promise<void>;
}
```

**Context** provides:
- `env` - Environment variables (Supabase, FreeClimb, etc.)
- `callId` - FreeClimb call identifier
- `from` - Caller's phone number
- `to` - Called phone number
- `sessionId` - Optional session identifier (for state)

**SpeechInput** contains:
- `text` - Transcribed speech from caller
- `confidence` - Transcription confidence score
- `language` - Detected language

**AppResponse** specifies:
- `speech` - What to say (text, voice, language)
- `prompt` - Whether to listen for another response
- `hangup` - Whether to end the call
- `transfer` - Phone number to transfer to

## File Structure

```
src/
├── index.ts              # Platform entry point, webhook handlers
├── core/
│   ├── types.ts          # Core interfaces and types
│   └── registry.ts       # App registration and routing
└── apps/
    └── echo.ts           # Example app: repeats what caller says
```

## Speech I/O

### Input: RecordUtterance

FreeClimb's `RecordUtterance` command:
- Records caller's speech
- Transcribes to text
- POSTs to `/transcription` webhook with `recognitionResult.transcript`

```typescript
{
  RecordUtterance: {
    actionUrl: '/transcription',
    autoStart: true,
    maxLengthSec: 30,
    grammarType: 'URL',
    grammarFile: 'builtin:speech/transcribe'
  }
}
```

### Output: Say

FreeClimb's `Say` command converts text to speech:

```typescript
{
  Say: {
    text: 'Hello, how can I help you?',
    voice: 'female',
    language: 'en-US'
  }
}
```

## App Routing

Currently: All calls route to default app (EchoApp).

**Future:** Database-backed routing:
- `apps` table - Registered apps and config
- `phone_numbers` table - Phone number → app_id mapping
- Query on incoming call to route to correct app

## Creating a New App

1. Create file in `src/apps/my-app.ts`:

```typescript
import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from '../core/types.js';

export class MyApp implements VoxnosApp {
  id = 'my-app';
  name = 'My App';

  async onStart(context: AppContext): Promise<AppResponse> {
    return {
      speech: { text: 'Welcome!' },
      prompt: true
    };
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    // Your logic here
    return {
      speech: { text: `Processing: ${input.text}` },
      prompt: true
    };
  }
}
```

2. Register in `src/index.ts`:

```typescript
import { MyApp } from './apps/my-app.js';
registry.register(new MyApp());
```

## Example Apps to Build

- **Conversational AI** - Integrate Claude API for natural dialogue
- **Survey bot** - Ask questions, collect responses, store in Supabase
- **Appointment scheduler** - Check availability, book appointments
- **FAQ bot** - Answer common questions using RAG
- **Call screening** - Identify caller, route based on purpose
- **Voicemail** - Custom greeting, record message, email transcription

## State Management

**TODO:** Add session support:
- `sessions` table in Supabase
- Store session state per call
- Pass `sessionId` in context
- Apps can load/save state between turns

## Database Schema (Future)

```sql
-- Apps registry
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Phone number routing
CREATE TABLE phone_numbers (
  number TEXT PRIMARY KEY,
  app_id TEXT REFERENCES apps(id),
  active BOOLEAN DEFAULT true
);

-- Call sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id TEXT UNIQUE NOT NULL,
  app_id TEXT REFERENCES apps(id),
  from_number TEXT,
  to_number TEXT,
  state JSONB,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

-- Conversation messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id),
  role TEXT CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  confidence FLOAT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Deployment

```bash
npx wrangler deploy
```

Auto-deploy via GitHub Actions on push to `master` (TODO).

## Environment Variables

Set via `npx wrangler secret put <NAME>`:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FREECLIMB_ACCOUNT_ID`
- `FREECLIMB_API_KEY`

## Testing

Local dev requires public URL for FreeClimb webhooks:

```bash
npm run dev  # Start on localhost:8787
cloudflared tunnel --url http://localhost:8787
```

Update FreeClimb phone number voice URL to tunnel URL.

## Current Status

- ✅ Core platform architecture
- ✅ App interface and routing
- ✅ Speech transcription (RecordUtterance)
- ✅ TTS synthesis (Say)
- ✅ Example Echo app
- ⏳ Database schema
- ⏳ Session management
- ⏳ Phone number → app routing
- ⏳ Claude API integration app

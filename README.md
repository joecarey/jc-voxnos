# jc-voxnos

Platform for building speech-enabled voice applications using FreeClimb API.

## Concept

Voxnos is a **platform**, not a single IVR. It lets you build multiple **apps** that handle phone calls using:
- **Speech input** - Transcription instead of DTMF keypad
- **Speech output** - Text-to-speech synthesis
- **Conversational flow** - Open-ended dialogues, not just menus

## Architecture

```
Phone Call → FreeClimb → Voxnos Platform → App Router → Your App
                                 ↓
                            Speech I/O Layer
                         (Transcription + TTS)
```

## Building an App

Apps implement the `VoxnosApp` interface:

```typescript
import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from './core/types.js';

export class MyApp implements VoxnosApp {
  id = 'my-app';
  name = 'My Voice App';

  // Called when call starts
  async onStart(context: AppContext): Promise<AppResponse> {
    return {
      speech: { text: 'Welcome! How can I help you?' },
      prompt: true,  // Listen for caller's response
    };
  }

  // Called when caller speaks
  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    // Process input.text (transcribed speech)
    // Return response
    return {
      speech: { text: `You said: ${input.text}` },
      prompt: true,   // Keep listening
      hangup: false,  // Don't hang up yet
    };
  }

  // Optional: Called when call ends
  async onEnd(context: AppContext): Promise<void> {
    console.log('Call ended');
  }
}
```

Register your app in `src/index.ts`:

```typescript
import { MyApp } from './apps/my-app.js';
registry.register(new MyApp(), true);  // true = default app
```

## Included Apps

- **Echo App** (`src/apps/echo.ts`) - Simple demo that repeats what you say

## Stack

- **Cloudflare Workers** - Serverless hosting
- **FreeClimb API** - Telephony platform
  - `RecordUtterance` - Speech transcription
  - `Say` - Text-to-speech
- **TypeScript** - Type-safe development
- **Supabase** - Database (for sessions, logs, config)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure FreeClimb

1. Sign up at https://www.freeclimb.com/
2. Get Account ID and API Key
3. Purchase a phone number
4. Configure phone number:
   - **Voice URL**: `https://jc-voxnos.YOUR_SUBDOMAIN.workers.dev/voice`

### 3. Set environment variables

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put FREECLIMB_ACCOUNT_ID
npx wrangler secret put FREECLIMB_API_KEY
```

### 4. Deploy

```bash
npm run deploy
```

## Development

```bash
npm run dev
```

For local testing with FreeClimb, expose via tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
```

Update FreeClimb phone number voice URL to tunnel URL.

## API Endpoints

- `GET /` - Health check
- `GET /apps` - List registered apps
- `POST /voice` - FreeClimb incoming call webhook
- `POST /transcription` - FreeClimb transcription webhook

## Use Cases

- **Voice assistants** - Conversational AI with Claude API
- **Surveys** - Collect feedback via voice
- **Appointment scheduling** - Book/modify appointments
- **Information hotlines** - Answer questions
- **Call routing** - Intelligent call distribution
- **Voicemail** - Custom voicemail systems

## Next Steps

- [ ] Add database schema for sessions/messages
- [ ] Implement session state management
- [ ] Create Claude API integration app
- [ ] Add analytics/logging
- [ ] Phone number → app mapping in database
- [ ] Build admin dashboard

## Documentation

- [FreeClimb RecordUtterance](https://docs.freeclimb.com/reference/recordutterance)
- [FreeClimb Say](https://docs.freeclimb.com/reference/say-1)
- [PerCL Overview](https://docs.freeclimb.com/reference/percl-overview)

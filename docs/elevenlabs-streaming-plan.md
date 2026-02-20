# ElevenLabs Streaming Integration Plan

## Overview

Add direct ElevenLabs API integration to voxnos with audio streaming to FreeClimb, while preserving the existing built-in FreeClimb → ElevenLabs integration as a fallback option.

**Current State**: FreeClimb's built-in `Say` command with ElevenLabs voice provider
**Target State**: Dual-mode TTS with direct ElevenLabs streaming as primary, FreeClimb built-in as fallback

## Architecture

### Audio Flow

```
Claude Response → ElevenLabs API → Stream Audio → Cloudflare KV → FreeClimb Plays URL
                                                                  ↓
                                                          /audio/{audioId}
```

### Configuration

```typescript
type TTSMode = 'elevenlabs-stream' | 'freeclimb-builtin';

interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  model: string; // 'eleven_turbo_v2' recommended for latency
  streamChunkSize: number; // bytes per chunk
}
```

## Implementation Phases

### Phase 1: Foundation (1-2 hours)

Create TTS abstraction layer and ElevenLabs client.

**Files to create:**
- `src/tts/types.ts` - Shared TTS interfaces
- `src/tts/elevenlabs.ts` - ElevenLabs API client
- `src/tts/freeclimb.ts` - FreeClimb Say wrapper
- `src/tts/index.ts` - Mode selector

**Code: `src/tts/elevenlabs.ts`**

```typescript
import type { Env } from '../index.js';

export interface TTSRequest {
  text: string;
  voiceId: string;
  model?: string;
}

export interface TTSResult {
  audioId: string;
  audioUrl: string;
  durationMs: number;
  sizeBytes: number;
}

/**
 * Generate speech using ElevenLabs API and store in KV.
 * Returns URL that FreeClimb can play.
 */
export async function generateSpeech(
  env: Env,
  request: TTSRequest
): Promise<TTSResult> {
  const audioId = generateAudioId();
  const model = request.model ?? 'eleven_turbo_v2';

  // Call ElevenLabs text-to-speech endpoint
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${request.voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: request.text,
        model_id: model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status}`);
  }

  // Stream response to array buffer
  const audioBuffer = await response.arrayBuffer();
  const sizeBytes = audioBuffer.byteLength;

  // Store in KV with 1-hour TTL (calls are typically < 10 min)
  await env.AUDIO_CACHE.put(
    audioId,
    audioBuffer,
    {
      expirationTtl: 3600,
      metadata: {
        voiceId: request.voiceId,
        model,
        sizeBytes,
        createdAt: new Date().toISOString(),
      },
    }
  );

  // Estimate duration (MP3 at ~128 kbps average)
  const durationMs = Math.floor((sizeBytes * 8) / 128);

  return {
    audioId,
    audioUrl: `https://jc-voxnos.cloudflare-5cf.workers.dev/audio/${audioId}`,
    durationMs,
    sizeBytes,
  };
}

function generateAudioId(): string {
  return `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
```

**Code: `src/tts/freeclimb.ts`**

```typescript
/**
 * Generate FreeClimb Say command (existing built-in integration).
 */
export function generateSayCommand(
  text: string,
  voice: string = 'Joanna'
): any {
  return {
    Say: {
      text,
      voice,
      language: 'en-US',
    },
  };
}
```

**Code: `src/tts/index.ts`**

```typescript
import type { Env } from '../index.js';
import { generateSpeech as elevenLabsGenerate, type TTSResult } from './elevenlabs.js';
import { generateSayCommand } from './freeclimb.js';

export type TTSMode = 'elevenlabs-stream' | 'freeclimb-builtin';

/**
 * Unified TTS interface with fallback support.
 */
export async function generateTTS(
  env: Env,
  text: string,
  mode: TTSMode = 'elevenlabs-stream'
): Promise<{ type: 'audio_url'; url: string; audioId: string } | { type: 'say_command'; command: any }> {

  if (mode === 'elevenlabs-stream') {
    try {
      const result = await elevenLabsGenerate(env, {
        text,
        voiceId: env.ELEVENLABS_VOICE_ID,
      });

      return {
        type: 'audio_url',
        url: result.audioUrl,
        audioId: result.audioId,
      };
    } catch (error) {
      console.error('ElevenLabs streaming failed, falling back to FreeClimb built-in:', error);
      // Fall through to FreeClimb mode
    }
  }

  // FreeClimb built-in mode (or fallback)
  return {
    type: 'say_command',
    command: generateSayCommand(text, env.FREECLIMB_VOICE),
  };
}
```

### Phase 2: Audio Endpoint (30 minutes)

Create `/audio/{audioId}` endpoint to serve cached audio to FreeClimb.

**Code: `src/index.ts` (add endpoint)**

```typescript
// GET /audio/{audioId} - Serve cached audio
if (url.pathname.startsWith('/audio/') && request.method === 'GET') {
  const audioId = url.pathname.split('/')[2];

  if (!audioId) {
    return new Response('Missing audio ID', { status: 400 });
  }

  const cached = await env.AUDIO_CACHE.getWithMetadata(audioId, 'arrayBuffer');

  if (!cached.value) {
    return new Response('Audio not found or expired', { status: 404 });
  }

  return new Response(cached.value, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
      'X-Audio-Size': String(cached.metadata?.sizeBytes ?? 0),
    },
  });
}
```

**Cloudflare KV Namespace**: Add `AUDIO_CACHE` binding to `wrangler.toml`

```toml
[[kv_namespaces]]
binding = "AUDIO_CACHE"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"
```

### Phase 3: Integration with Call Flow (1-2 hours)

Update call handling to use new TTS system with fallback logic.

**Code: `src/index.ts` (modify POST /call endpoint)**

```typescript
import { generateTTS } from './tts/index.js';

// Inside call handler, when responding with Claude's answer
const ttsMode: TTSMode = env.TTS_MODE ?? 'elevenlabs-stream';

const ttsResult = await generateTTS(env, claudeResponse, ttsMode);

let perclResponse;

if (ttsResult.type === 'audio_url') {
  // ElevenLabs streaming mode
  perclResponse = [
    {
      Play: {
        file: ttsResult.url,
      },
    },
    {
      Say: {
        text: 'What else can I help you with?',
        voice: env.FREECLIMB_VOICE ?? 'Joanna',
      },
    },
    {
      GetSpeech: {
        actionUrl: `${baseUrl}/call`,
        grammarType: 'URL',
        grammarFile: 'builtin:speech/transcribe',
        prompts: [],
      },
    },
  ];
} else {
  // FreeClimb built-in mode (existing logic)
  perclResponse = [
    ttsResult.command,
    {
      Say: {
        text: 'What else can I help you with?',
        voice: env.FREECLIMB_VOICE ?? 'Joanna',
      },
    },
    {
      GetSpeech: {
        actionUrl: `${baseUrl}/call`,
        grammarType: 'URL',
        grammarFile: 'builtin:speech/transcribe',
        prompts: [],
      },
    },
  ];
}
```

### Phase 4: Testing & Validation (1 hour)

**Test Cases:**

1. **Happy path (ElevenLabs streaming)**
   - Make call, ask question
   - Verify audio generates and plays correctly
   - Check KV storage contains audio
   - Verify audio quality and latency acceptable

2. **Fallback scenario**
   - Simulate ElevenLabs API failure (wrong API key)
   - Verify automatic fallback to FreeClimb built-in
   - Confirm call continues without interruption

3. **Audio endpoint**
   - Generate audio via ElevenLabs
   - Fetch `/audio/{audioId}` directly
   - Verify correct Content-Type and audio plays

4. **KV expiration**
   - Generate audio, wait for TTL expiry (test with short TTL)
   - Verify 404 on expired audio
   - Confirm regeneration works on subsequent calls

5. **Load testing**
   - Multiple concurrent calls
   - Verify KV storage handles parallel writes
   - Check for race conditions or conflicts

### Phase 5: Deployment & Rollout (30 minutes)

**Environment Variables** (add to Cloudflare Workers):

```bash
# ElevenLabs configuration
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # Rachel voice (or your choice)

# TTS mode selection
TTS_MODE=elevenlabs-stream  # or 'freeclimb-builtin'

# FreeClimb fallback voice
FREECLIMB_VOICE=Joanna
```

**Deployment Steps:**

1. Create KV namespace: `wrangler kv:namespace create AUDIO_CACHE`
2. Update `wrangler.toml` with KV binding
3. Add environment variables via Cloudflare dashboard
4. Deploy: `npm run deploy`
5. Test with small set of calls
6. Monitor logs for errors or latency issues
7. Gradually roll out to all calls

**Rollback Plan:**

If issues arise, set `TTS_MODE=freeclimb-builtin` via environment variable (no code deployment needed).

## Risk Mitigation

### Risk 1: Timing Delays

**Problem**: ElevenLabs API call + KV storage adds latency before FreeClimb can play audio.

**Mitigation**:
- Use `eleven_turbo_v2` model (optimized for low latency)
- Stream audio in chunks if possible (advanced - may require WebSocket)
- Add timeout (3-5 seconds) with automatic fallback to FreeClimb built-in
- Monitor P95/P99 latency in production

**Code for timeout:**

```typescript
const ELEVENLABS_TIMEOUT_MS = 5000;

try {
  const result = await Promise.race([
    elevenLabsGenerate(env, { text, voiceId: env.ELEVENLABS_VOICE_ID }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ElevenLabs timeout')), ELEVENLABS_TIMEOUT_MS)
    ),
  ]);
  // Use result
} catch (error) {
  console.error('ElevenLabs failed or timed out, using FreeClimb:', error);
  // Fallback to FreeClimb
}
```

### Risk 2: ElevenLabs API Failures

**Problem**: API downtime, rate limits, or errors break calls.

**Mitigation**:
- Automatic fallback to FreeClimb built-in (already implemented)
- Retry logic with exponential backoff (1 retry only to avoid latency)
- Monitor error rates and alert on sustained failures
- Consider caching common responses (greetings, etc.)

### Risk 3: Audio Streaming Drops

**Problem**: FreeClimb fails to fetch audio from `/audio/{audioId}` endpoint.

**Mitigation**:
- Set generous KV TTL (1 hour) to ensure audio available during call
- Return proper HTTP status codes (404 for expired, 500 for errors)
- Log all audio fetch failures for debugging
- Test with FreeClimb's network conditions (latency, retries)

### Risk 4: KV Storage Limits

**Problem**: High call volume exhausts KV storage or write limits.

**Mitigation**:
- Use aggressive TTL (1 hour) to auto-purge old audio
- Monitor KV usage metrics in Cloudflare dashboard
- Consider LRU eviction for old audio if approaching limits
- Estimate: ~100KB/audio × 1000 calls/day × 1hr TTL = ~4GB max (well within KV limits)

## Success Criteria

- [ ] ElevenLabs streaming works end-to-end in production calls
- [ ] Fallback to FreeClimb built-in activates automatically on ElevenLabs errors
- [ ] Audio quality is equal or better than FreeClimb built-in
- [ ] P95 latency < 3 seconds from Claude response to audio playback start
- [ ] Zero dropped calls due to TTS failures
- [ ] KV storage stays within budget and TTL cleans up automatically
- [ ] Monitoring and alerts in place for API failures

## Cost Analysis

**ElevenLabs Pricing** (as of 2024):
- ~$0.30 per 1000 characters (Turbo model)
- Average response: ~500 characters = $0.15 per call
- 1000 calls/month = ~$150/month

**FreeClimb Built-in** (existing):
- Included in per-minute call pricing
- No additional TTS cost

**Recommendation**: Use ElevenLabs streaming for premium experience, FreeClimb built-in for cost-sensitive scenarios or as fallback.

## Future Enhancements

1. **WebSocket Streaming**: Stream audio directly to FreeClimb as it's generated (requires FreeClimb WebSocket support)
2. **Voice Cloning**: Use custom ElevenLabs voice clone for branded experience
3. **SSML Support**: Add prosody controls for emphasis, pauses, etc.
4. **Audio Caching**: Cache common responses (greetings, FAQs) to reduce API calls
5. **Multi-Voice Support**: Different voices for different tool responses (weather vs cognos brief)
6. **Monitoring Dashboard**: Real-time latency, error rates, fallback frequency

## References

- [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [FreeClimb PerCL Play Command](https://docs.freeclimb.com/reference/percl-play)
- [Cloudflare KV Documentation](https://developers.cloudflare.com/kv/)

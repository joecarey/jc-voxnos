# Voxnos Roadmap

Living document for platform direction. Not a commitment list — a reference for planning conversations.

## Near-term — build on what exists

### Outbound calling
The platform only handles inbound calls. FreeClimb supports OutDial — adding outbound would unlock appointment reminders, follow-up calls, proactive surveys, and automated check-ins. The engine and app framework are already call-direction agnostic; the work is in the telephony layer (initiating calls, handling answering machine detection) and a trigger mechanism (API endpoint, scheduled, or webhook-driven).

### Caller recognition and cross-call memory
Every call starts fresh right now. The platform already has the caller's phone number in every CDR. Recognizing returning callers and threading context across calls ("Last time you asked about the weather in Austin") would make conversations feel dramatically more personal. Could be as simple as a `caller_profiles` D1 table keyed by phone number, with a summary field that gets injected into the system prompt. Claude handles the rest.

### CDR analytics
The raw data is there — call records, turn-by-turn transcripts, token usage, outcomes. What's missing is an aggregation layer: calls per day, average duration, transfer rates, survey completion rates, common caller intents, cost per call. Could be a set of admin endpoints that run SQL aggregations on D1, or a periodic job that writes summary rows.

### External transfer (human handoff)
Internal transfers (app-to-app) work well. The next step is transferring to an external phone number — a human agent, a support line, a specific person. FreeClimb supports this via OutDial within an active call. The transfer tool would need a `transfer_to_number` variant alongside the existing `transfer_to_app`. Critical for any production deployment where AI can't handle every scenario.

### Prompt versioning
Updating an app definition overwrites the config. There's no way to see what changed or roll back a bad prompt edit. A `app_definition_versions` table that stores each revision (with a timestamp and optional note) would make it safe to iterate on prompts in production. The admin API would grow a `/apps/definitions/:id/versions` endpoint and a restore action.

## Medium-term — new capabilities

### More deterministic app types
SurveyApp proved the pattern: structured, non-LLM interactions created via API. Other candidates:
- **Appointment scheduler** — date/time slot selection with confirmation, backed by a calendar API tool
- **Order status lookup** — caller provides order number, app queries an external API, reads back status
- **FAQ/decision tree** — branching logic based on caller responses, no LLM needed for predictable paths
- **Intake form** — collect structured data (name, DOB, reason for call) before transferring to a specialist

Each would be a new subclass of BaseApp with its own config shape in `app_definitions`, following the same zero-code pattern as SurveyApp.

### Webhook/event system
Fire HTTP callbacks on platform events: call completed, survey finished, transfer occurred, error threshold hit. Would let external systems react in real time — update a CRM, send a Slack notification, trigger a follow-up workflow. The event payload would include the CDR data that's already being collected.

### Multi-language support
Google Chirp 3 HD supports dozens of languages. The platform could add a `language` field to app definitions that selects the TTS voice language and (optionally) tells Claude to respond in that language. Combined with FreeClimb's speech recognition language parameter, this would make the platform usable for non-English markets with no code changes.

### Testing infrastructure
Automated call flow testing. Simulate a caller (scripted utterances), run through the full webhook cycle, verify the response sequence. Would catch regressions when prompts change, TTS providers update, or the engine is refactored. Could run as a CI step or an on-demand admin endpoint.

## Longer-term — platform expansion

### Multi-channel
The engine is already telephony-agnostic — it returns `TurnResult` and doesn't know about FreeClimb. Adding a WebSocket or WebRTC channel would let the same apps work via browser or mobile app. The app definitions, tool system, CDR, and conversation history would all work unchanged. Only the transport layer (replacing PerCL with WebSocket messages) and TTS delivery (streaming audio directly instead of via KV) would need new code.

### Real-time dashboard
Live view of active calls, recent completions, error rates, transfer patterns. The CDR data and structured logging already capture everything needed. This is a frontend project more than a backend one — the admin API provides the data, the dashboard visualizes it.

### Voice cloning / custom voices
ElevenLabs supports custom voice cloning. Combined with the per-app voice system that's already in place, this could let each app have a truly unique voice rather than choosing from a provider's stock voices. The TTS abstraction layer (`callTTS`, `voiceSlug`) already supports provider-specific voice identifiers.

### Agentic workflows
Today each app handles a single call in isolation. Agentic workflows would let an app kick off multi-step processes that span beyond the call: "I'll look into that and call you back" → outbound call with results. Requires outbound calling (above) plus a durable workflow system (possibly Cloudflare Workflows or Durable Objects) to manage state between the inbound and outbound legs.

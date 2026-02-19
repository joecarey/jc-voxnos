# jc-voxnos

Simple IVR (Interactive Voice Response) application using FreeClimb API and Cloudflare Workers.

## Architecture

- **Cloudflare Workers** - Serverless webhook handlers
- **FreeClimb API** - Cloud telephony platform
- **PerCL** - FreeClimb's JSON command language for call control
- **Supabase** - Database for call logs and configuration (future)

## Webhooks

### `/voice` (POST)
- Receives incoming call notifications from FreeClimb
- Returns PerCL commands to greet caller and present menu
- Request includes: `callId`, `from`, `to`, `callStatus`

### `/menu` (POST)
- Receives DTMF input from caller
- Returns PerCL commands based on selection
- Request includes: `callId`, `digits`, `reason`

## PerCL Commands

FreeClimb uses JSON-based PerCL (Persephony Command Language) to control calls:

```typescript
// Example: Say text to caller
{ Say: { text: "Welcome to VoxNos" } }

// Example: Get DTMF digits
{ GetDigits: {
    prompts: [{ Say: { text: "Press 1" } }],
    maxDigits: 1,
    actionUrl: "/menu"
  }
}

// Example: Hang up
{ Hangup: {} }

// Example: Redirect to another URL
{ Redirect: { actionUrl: "/voice" } }
```

## Current Implementation

Simple menu system:
- Press 1 → Sales
- Press 2 → Support
- Press 0 → Operator
- Invalid → Replay menu

Currently just announces the selection and hangs up. Future: actually route calls.

## FreeClimb Setup

1. Account ID and API Key stored as Cloudflare secrets
2. Phone number configured with voice URL pointing to `/voice` endpoint
3. All webhooks must be publicly accessible HTTPS URLs

## Development

Local testing with FreeClimb requires a public URL:
```bash
npx wrangler dev  # Start local dev server on :8787
cloudflared tunnel --url http://localhost:8787  # Expose via tunnel
```

Update FreeClimb phone number voice URL to tunnel URL during testing.

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

## Future Features

- Call logging to Supabase (store call metadata, duration, menu selections)
- Actual call forwarding using FreeClimb's OutDial command
- Voicemail recording with Record command
- Integration with Claude API for conversational IVR
- Call analytics dashboard
- Business hours routing
- Queue management

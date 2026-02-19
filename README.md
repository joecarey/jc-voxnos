# jc-voxnos

Simple IVR (Interactive Voice Response) application using FreeClimb API.

## Stack

- **Cloudflare Workers** - Serverless hosting for webhook handlers
- **FreeClimb API** - Cloud telephony platform
- **TypeScript** - Type-safe development
- **Supabase** - Database (for call logs, future features)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure FreeClimb

1. Sign up for a FreeClimb account at https://www.freeclimb.com/
2. Get your Account ID and API Key from the dashboard
3. Purchase a phone number
4. Configure the phone number's voice URL to point to your deployed worker:
   - Voice URL: `https://jc-voxnos.YOUR_SUBDOMAIN.workers.dev/voice`

### 3. Set environment variables

```bash
# Supabase
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# FreeClimb
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

For local testing with FreeClimb webhooks, use [ngrok](https://ngrok.com/) or [cloudflared tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Then update your FreeClimb phone number's voice URL to the tunnel URL.

## Current Features

- **Simple IVR menu** - Press 1 for sales, 2 for support, 0 for operator
- **Text-to-speech** - Uses FreeClimb's built-in TTS
- **DTMF input handling** - Captures and routes based on key presses

## Next Steps

- [ ] Add call logging to Supabase
- [ ] Implement call forwarding to real numbers
- [ ] Add voicemail recording
- [ ] Build call analytics dashboard
- [ ] Integrate with Claude API for conversational IVR

## FreeClimb Documentation

- [PerCL Commands](https://docs.freeclimb.com/reference/percl-overview)
- [Webhooks](https://docs.freeclimb.com/docs/webhooks-overview)
- [Say Command](https://docs.freeclimb.com/reference/say-1)
- [GetDigits Command](https://docs.freeclimb.com/reference/getdigits)

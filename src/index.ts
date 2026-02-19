// FreeClimb IVR Application
// Handles incoming calls with a simple menu system

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  FREECLIMB_ACCOUNT_ID: string;
  FREECLIMB_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // FreeClimb voice webhook - handles incoming calls
    if (url.pathname === '/voice' && request.method === 'POST') {
      return handleIncomingCall(request, env);
    }

    // FreeClimb menu response - handles DTMF input
    if (url.pathname === '/menu' && request.method === 'POST') {
      return handleMenuResponse(request, env);
    }

    // Health check
    if (url.pathname === '/') {
      return new Response('jc-voxnos running', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleIncomingCall(request: Request, env: Env): Promise<Response> {
  console.log('Incoming call received');

  // FreeClimb sends call data in the request body
  const body = await request.json() as {
    callId: string;
    from: string;
    to: string;
    callStatus: string;
  };

  console.log(`Call from ${body.from} to ${body.to}`);

  // Build PerCL (FreeClimb's JSON command language) response
  const percl = [
    {
      Say: {
        text: 'Welcome to VoxNos. Press 1 for sales, Press 2 for support, or Press 0 for the operator.',
      },
    },
    {
      GetDigits: {
        prompts: [
          {
            Say: {
              text: 'Please make your selection now.',
            },
          },
        ],
        maxDigits: 1,
        minDigits: 1,
        flushBuffer: true,
        actionUrl: `${new URL(request.url).origin}/menu`,
      },
    },
  ];

  return Response.json(percl, {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleMenuResponse(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    callId: string;
    digits: string;
    reason: string;
  };

  console.log(`Menu selection: ${body.digits}`);

  let percl;

  switch (body.digits) {
    case '1':
      percl = [
        {
          Say: {
            text: 'Connecting you to sales.',
          },
        },
        // In production, you'd use Redirect or OutDial to route the call
        {
          Say: {
            text: 'Thank you for calling. Goodbye.',
          },
        },
        {
          Hangup: {},
        },
      ];
      break;

    case '2':
      percl = [
        {
          Say: {
            text: 'Connecting you to support.',
          },
        },
        {
          Say: {
            text: 'Thank you for calling. Goodbye.',
          },
        },
        {
          Hangup: {},
        },
      ];
      break;

    case '0':
      percl = [
        {
          Say: {
            text: 'Transferring you to the operator.',
          },
        },
        {
          Say: {
            text: 'Thank you for calling. Goodbye.',
          },
        },
        {
          Hangup: {},
        },
      ];
      break;

    default:
      percl = [
        {
          Say: {
            text: 'Invalid selection. Please try again.',
          },
        },
        {
          Redirect: {
            actionUrl: `${new URL(request.url).origin}/voice`,
          },
        },
      ];
      break;
  }

  return Response.json(percl, {
    headers: { 'Content-Type': 'application/json' },
  });
}

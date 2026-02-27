import type { Env } from "./engine/types.js";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { handleFetch } from "./index.js";

/**
 * Default handler for non-API routes.
 * Handles the OAuth authorize flow (password login) and delegates
 * all other paths to the existing REST API handler.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // OAuth authorize endpoint
    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        return handleAuthorizeGet(request, env);
      }
      if (request.method === "POST") {
        return handleAuthorizePost(request, env);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // All other paths → existing REST API
    return handleFetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/** GET /authorize — render a simple password form */
async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);

  if (!client) {
    return new Response("Unknown client", { status: 400 });
  }

  return new Response(renderLoginPage(oauthReq, client.clientName), {
    headers: { "Content-Type": "text/html" },
  });
}

/** POST /authorize — validate password, complete authorization */
async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const password = formData.get("password") as string;

  if (!password || password !== env.AUTH_PASSWORD) {
    const oauthReq = reconstructAuthRequest(formData);
    return new Response(renderLoginPage(oauthReq, undefined, "Invalid password"), {
      status: 401,
      headers: { "Content-Type": "text/html" },
    });
  }

  const oauthReq = reconstructAuthRequest(formData);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "jc",
    metadata: { label: "voxnos-owner" },
    scope: oauthReq.scope,
    props: { user: "jc", role: "owner" },
  });

  return Response.redirect(redirectTo, 302);
}

/** Reconstruct AuthRequest from hidden form fields */
function reconstructAuthRequest(formData: FormData): AuthRequest {
  return {
    responseType: formData.get("response_type") as string,
    clientId: formData.get("client_id") as string,
    redirectUri: formData.get("redirect_uri") as string,
    state: formData.get("state") as string,
    scope: ((formData.get("scope") as string) || "").split(" ").filter(Boolean),
    codeChallenge: (formData.get("code_challenge") as string) || undefined,
    codeChallengeMethod: (formData.get("code_challenge_method") as string) || undefined,
  };
}

/** Render minimal HTML login page */
function renderLoginPage(oauthReq: AuthRequest, clientName?: string, error?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>voxnos — authorize</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4em; font-weight: 600; }
    .client { color: #666; font-size: 0.9em; margin-bottom: 24px; }
    .error { color: #c00; margin-bottom: 16px; font-size: 0.9em; }
    label { display: block; font-size: 0.9em; margin-bottom: 6px; color: #444; }
    input[type="password"] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1em; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 24px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  <h1>voxnos</h1>
  <p class="client">${clientName ? esc(clientName) + " wants" : "A client wants"} access to your voice platform.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <form method="POST" action="/authorize">
    <input type="hidden" name="response_type" value="${esc(oauthReq.responseType)}">
    <input type="hidden" name="client_id" value="${esc(oauthReq.clientId)}">
    <input type="hidden" name="redirect_uri" value="${esc(oauthReq.redirectUri)}">
    <input type="hidden" name="state" value="${esc(oauthReq.state)}">
    <input type="hidden" name="scope" value="${esc(oauthReq.scope.join(" "))}">
    ${oauthReq.codeChallenge ? `<input type="hidden" name="code_challenge" value="${esc(oauthReq.codeChallenge)}">` : ""}
    ${oauthReq.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${esc(oauthReq.codeChallengeMethod)}">` : ""}
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

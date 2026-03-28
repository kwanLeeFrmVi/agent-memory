/**
 * auth-handler.ts — OAuth authorization UI and user validation
 *
 * This implements a self-hosted OAuth flow where the Worker itself
 * validates users against a hashed allow-list stored in secrets.
 */
import type { Env } from "./core/env.ts";

interface OAuthHelpers {
  parseAuthRequest: (request: Request) => Promise<{
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }>;
  lookupClient: (clientId: string) => Promise<{
    client_id: string;
    client_name?: string;
    redirect_uris: string[];
    logo_uri?: string;
  } | null>;
  completeAuthorization: (options: {
    request: {
      response_type: string;
      client_id: string;
      redirect_uri: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
    };
    userId: string;
    metadata?: Record<string, unknown>;
    scope: string[];
    props: Record<string, unknown>;
  }) => Promise<{ redirectTo: string }>;
}

interface AuthContext {
  OAUTH_PROVIDER: OAuthHelpers;
}

// Simple bcrypt-like verification using Web Crypto API
// For production, use a proper bcrypt library
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Hash format: $2b$12$... (bcrypt)
  // For simplicity in Workers, we'll use a SHA-256 based comparison
  // In production, install a bcrypt library like 'bcryptjs'

  // If hash starts with $2b$, it's bcrypt - we need a library
  // For now, support a simpler format: "sha256:salt:hash"
  if (hash.startsWith("sha256:")) {
    const [, salt, storedHash] = hash.split(":");
    const encoder = new TextEncoder();
    const data = encoder.encode(salt + password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const computedHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    return computedHash === storedHash;
  }

  // For bcrypt hashes, we'd need a library - return false for now
  // User should use sha256:salt:hash format for Workers compatibility
  console.error("Bcrypt hashes require a library. Use sha256:salt:hash format for AUTH_ALLOWED_USERS");
  return false;
}

function generateHash(password: string, salt: string): string {
  // Helper for generating hashes (not used at runtime, but documented)
  // Run in Node: crypto.createHash('sha256').update(salt + password).digest('hex')
  return `sha256:${salt}:${password}`; // placeholder
}

// Parse allowed users from secret
function parseAllowedUsers(json: string): Array<{ username: string; password_hash: string }> {
  try {
    return JSON.parse(json);
  } catch {
    console.error("Invalid AUTH_ALLOWED_USERS JSON format");
    return [];
  }
}

// Render login form HTML
function renderLoginForm(actionUrl: string, error?: string, isDirectLogin: boolean = false): string {
  const subtitle = isDirectLogin ? "Sign in to verify your credentials" : "Sign in to authorize MCP client access";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Memory - Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    h1 {
      color: #333;
      margin-bottom: 8px;
      font-size: 24px;
    }
    p.subtitle {
      color: #666;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    label {
      display: block;
      color: #555;
      margin-bottom: 6px;
      font-size: 14px;
      font-weight: 500;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .footer {
      margin-top: 20px;
      text-align: center;
      color: #999;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🧠 Agent Memory</h1>
    <p class="subtitle">${subtitle}</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="${actionUrl}">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Authorize</button>
    </form>
    <div class="footer">
      Secure MCP Server • OAuth 2.1
    </div>
  </div>
</body>
</html>`;
}

// Render login success page
function renderLoginSuccess(username: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Memory - Login Successful</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    h1 { color: #333; margin-bottom: 16px; font-size: 24px; }
    p { color: #666; font-size: 14px; line-height: 1.5; }
    strong { color: #667eea; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🧠 Login Successful</h1>
    <p>Welcome, <strong>${username}</strong>!</p>
    <p>Your credentials have been verified. You can close this page.</p>
  </div>
</body>
</html>`;
}

// Render consent form HTML
function renderConsentForm(actionUrl: string, clientName: string, scopes: string[], username: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Memory - Authorize</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      width: 100%;
      max-width: 450px;
    }
    h1 { color: #333; margin-bottom: 8px; font-size: 24px; }
    p { color: #666; margin-bottom: 24px; font-size: 14px; line-height: 1.5; }
    .client-name {
      font-weight: 600;
      color: #667eea;
    }
    .scopes {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .scope {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
      font-size: 14px;
      color: #555;
    }
    .scope:last-child { margin-bottom: 0; }
    .scope::before {
      content: "✓";
      color: #28a745;
      margin-right: 8px;
      font-weight: bold;
    }
    .buttons {
      display: flex;
      gap: 12px;
    }
    button {
      flex: 1;
      padding: 14px;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button.allow {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    button.deny {
      background: #f0f0f0;
      color: #666;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🧠 Authorize Access</h1>
    <p>
      <span class="client-name">${clientName}</span> is requesting access to your Agent Memory.
      This will allow the application to:
    </p>
    <div class="scopes">
      ${scopes.map(s => `<div class="scope">${s}</div>`).join("")}
    </div>
    <form method="POST" action="${actionUrl}">
      <input type="hidden" name="action" value="allow">
      <input type="hidden" name="username" value="${username}">
      <div class="buttons">
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
        <button type="submit" name="action" value="allow" class="allow">Allow</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

// Main auth handler
export async function authHandler(
  request: Request,
  env: Env & AuthContext
): Promise<Response> {
  const url = new URL(request.url);

  // OAuth metadata endpoint
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    const origin = url.origin;
    return new Response(JSON.stringify({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["memory:read", "memory:write", "memory:admin"],
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Authorization endpoint - GET shows login form
  if (url.pathname === "/authorize" && request.method === "GET") {
    // Check if this is a direct visit (no OAuth params)
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    
    if (!clientId || !redirectUri) {
      // Direct visit - show a simple login form that just validates credentials
      return new Response(renderLoginForm(url.pathname + url.search, undefined, true), {
        headers: { "Content-Type": "text/html" },
      });
    }
    
    // OAuth flow - preserve full URL with query params for form submission
    return new Response(renderLoginForm(url.pathname + url.search), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Authorization endpoint - POST handles both login and consent
  if (url.pathname === "/authorize" && request.method === "POST") {
    const formData = await request.formData();
    const action = formData.get("action") as string;

    // Handle consent form submission (action field present)
    if (action === "deny") {
      return new Response("Authorization denied", { status: 401 });
    }

    if (action === "allow") {
      // Re-parse to get the OAuth params (they should be in the query string)
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

      // Get username from hidden field
      const username = formData.get("username") as string;
      const allowedUsers = parseAllowedUsers(env.AUTH_ALLOWED_USERS);
      const user = allowedUsers.find(u => u.username === username);

      if (!user) {
        return new Response("Session expired - please retry login", { status: 400 });
      }

      // Complete authorization
      let scopes: string[] = ["memory:read"];
      if (oauthReqInfo.scope) {
        scopes = Array.isArray(oauthReqInfo.scope) 
          ? oauthReqInfo.scope 
          : typeof oauthReqInfo.scope === 'string' 
            ? oauthReqInfo.scope.split(" ") 
            : ["memory:read"];
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: username,
        metadata: { login_time: new Date().toISOString() },
        scope: scopes,
        props: {
          userId: username,
          username: username,
        },
      });

      return Response.redirect(redirectTo, 302);
    }

    // Handle login form submission (no action field)
    const username = formData.get("username") as string;
    const password = formData.get("password") as string;
    
    console.log("Login attempt:", { username, hasPassword: !!password, url: request.url });

    // Validate credentials
    const allowedUsers = parseAllowedUsers(env.AUTH_ALLOWED_USERS);
    const user = allowedUsers.find(u => u.username === username);

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return new Response(renderLoginForm(url.pathname + url.search, "Invalid username or password"), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Parse the original OAuth request from URL query params (POST body doesn't contain them)
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    
    // Also get params directly from URL since form POST preserves them in query string
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    
    console.log("OAuth params from URL:", { clientId, redirectUri });
    
    // Check if this is a direct login (no OAuth client)
    if (!clientId || !redirectUri) {
      // Direct login - show success page
      return new Response(renderLoginSuccess(username), {
        headers: { "Content-Type": "text/html" },
      });
    }
    
    const clientInfo = await env.OAUTH_PROVIDER.lookupClient(clientId!);
    
    console.log("Client lookup result:", { clientId, found: !!clientInfo });

    // For MCP clients like Claude that don't dynamically register, 
    // we still want to allow the authorization to proceed.
    const clientName = clientInfo?.client_name || clientId || "MCP Client";

    // Show consent form with username passed through, preserve query params
    let scopes: string[] = ["memory:read"];
    if (oauthReqInfo.scope) {
      scopes = Array.isArray(oauthReqInfo.scope) 
        ? oauthReqInfo.scope 
        : typeof oauthReqInfo.scope === 'string' 
          ? oauthReqInfo.scope.split(" ") 
          : ["memory:read"];
    }
    
    return new Response(renderConsentForm(url.pathname + url.search, clientName, scopes, username), {
      headers: { "Content-Type": "text/html" },
    });
  }

  return new Response("Not found", { status: 404 });
}

// Export for OAuthProvider defaultHandler
export default {
  fetch: authHandler,
};

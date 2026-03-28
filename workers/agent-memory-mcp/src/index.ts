/**
 * index.ts — Cloudflare Worker entrypoint
 *
 * Exposes the agent-memory MCP server with OAuth 2.1 authentication.
 * Supports both Streamable HTTP and SSE transports.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, WorkerTransport } from "agents/mcp";
import type { Env } from "./core/env.ts";
import { createMcpServer } from "./server.ts";
import { authHandler } from "./auth-handler.ts";

// ── MCP Handler Factory ───────────────────────────────────────────────────────

function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const server = createMcpServer(env);

  // Create transport with SSE support and CORS
  const transport = new WorkerTransport({
    sessionIdGenerator: () => `session-${crypto.randomUUID()}`,
    corsOptions: {
      origin: "*", // Restrict in production if needed
      methods: "GET,POST,OPTIONS",
      headers: "Content-Type, Authorization",
    },
  });

  const handler = createMcpHandler(server, { transport });
  return handler(request, env, ctx);
}

// ── OAuth Provider Configuration ──────────────────────────────────────────────

// The OAuthProvider wraps our MCP handler and handles:
// - Dynamic client registration at /register
// - Token endpoint at /token
// - Authorization flow at /authorize (delegated to authHandler)
// - Token storage in OAUTH_KV

export default new OAuthProvider({
  // MCP API routes - these are protected by OAuth
  apiRoute: [
    "/mcp",
    "/mcp/sse", // SSE endpoint
    "/mcp/message", // Message endpoint for SSE
  ],

  // Handler for MCP requests (after OAuth validation)
  apiHandler: {
    fetch: mcpHandler,
  },

  // Handler for authorization UI (login/consent)
  defaultHandler: {
    fetch: authHandler,
  },

  // OAuth endpoints - these MUST match what's in .well-known/oauth-authorization-server
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",

  // Supported scopes
  scopesSupported: ["memory:read", "memory:write", "memory:admin"],

  // Allow any redirect URI for development
  // In production, you may want to restrict this
  allowImplicitFlow: false,
});

// ── Type augmentation for OAuth context ───────────────────────────────────────

// This makes auth context available in tools via getMcpAuthContext()
declare module "agents/mcp" {
  interface MCPToolAuthContext {
    userId: string;
    username: string;
  }
}

/**
 * index.ts — Cloudflare Worker entrypoint
 *
 * Exposes the agent-memory MCP server with OAuth 2.1 authentication.
 * Supports both Streamable HTTP and SSE transports.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./core/env.ts";
import { createMcpServer, createMcpServerLite } from "./server.ts";
import { authHandler } from "./auth-handler.ts";

// ── MCP Handler Factory ───────────────────────────────────────────────────────

async function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const isLite = url.searchParams.get("lite") === "true";
  const server = isLite ? createMcpServerLite(env) : createMcpServer(env);
  
  // Create web-standard streamable HTTP transport in stateless mode
  // (no sessionIdGenerator = stateless, works better with serverless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  
  // Connect server to transport
  server.connect(transport);
  
  // Handle the request
  return await transport.handleRequest(request);
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
declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  interface MCPToolAuthContext {
    userId: string;
    username: string;
  }
}

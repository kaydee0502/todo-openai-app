import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import crypto from "node:crypto";
import {
  createTodoItem,
  listTodoItems,
  registerTodoResources,
  registerTodoTools,
  updateTodoItem,
} from "./tools/todo-tools.js";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);

function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

// Minimal options:
// - If OAUTH_REQUIRED=1, the server will enforce Bearer auth using tokens minted via PKCE.
// - If MCP_BEARER_TOKEN is set, that static token is also accepted.
// - If neither is set, auth is disabled (local dev).
const OAUTH_REQUIRED = parseBoolEnv(process.env.OAUTH_REQUIRED, false);
const MCP_BEARER_TOKEN = (process.env.MCP_BEARER_TOKEN || "").trim();

// Optional hardening (still POC-friendly):
// If set, only this client_id is accepted; otherwise any client_id works.
const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID || "").trim();
// If set, token endpoint requires this secret (Basic or body). If empty, public client (PKCE only).
const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET || "").trim();
// If set, enforce redirect URIs allowlist (comma-separated); otherwise accept any.
const OAUTH_REDIRECT_URIS = (process.env.OAUTH_REDIRECT_URIS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type TokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

type ClientRecord = {
  clientId: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientName?: string;
  clientSecret?: string;
  clientIdIssuedAtSec: number;
  clientSecretExpiresAtSec?: number;
};

const clients = new Map<string, ClientRecord>();

function getClient(clientId: string): ClientRecord | undefined {
  const registered = clients.get(clientId);
  if (registered) return registered;

  // Optional static client (env-configured)
  if (OAUTH_CLIENT_ID && clientId === OAUTH_CLIENT_ID) {
    const method: TokenEndpointAuthMethod = OAUTH_CLIENT_SECRET ? "client_secret_basic" : "none";
    return {
      clientId,
      redirectUris: OAUTH_REDIRECT_URIS,
      tokenEndpointAuthMethod: method,
      clientSecret: OAUTH_CLIENT_SECRET || undefined,
      clientIdIssuedAtSec: Math.floor(Date.now() / 1000),
      clientSecretExpiresAtSec: OAUTH_CLIENT_SECRET ? 0 : undefined,
    };
  }

  return undefined;
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "openai-todo-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  registerTodoResources(server);
  registerTodoTools(server);
  return server;
}

function parseBearerToken(req: express.Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

type AuthCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAtMs: number;
};

type AccessTokenRecord = {
  clientId: string;
  expiresAtMs: number;
};

const authCodes = new Map<string, AuthCodeRecord>();
const accessTokens = new Map<string, AccessTokenRecord>();

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pkceS256(verifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBasicAuth(req: express.Request): { username: string; password: string } | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match?.[1]) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function issuerFor(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function oauthMetadata(req: express.Request) {
  const issuer = issuerFor(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
  };
}

function protectedResourceMetadata(req: express.Request) {
  const issuer = issuerFor(req);
  return {
    resource: `${issuer}/sse`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  };
}

function requireAuth(req: express.Request, res: express.Response): boolean {
  const authEnabled = Boolean(MCP_BEARER_TOKEN) || OAUTH_REQUIRED;
  if (!authEnabled) return true;

  const token = parseBearerToken(req);
  if (!token) {
    res.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return false;
  }

  if (MCP_BEARER_TOKEN && token === MCP_BEARER_TOKEN) return true;

  const record = accessTokens.get(token);
  if (!record) {
    res.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return false;
  }
  if (Date.now() >= record.expiresAtMs) {
    accessTokens.delete(token);
    res.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return false;
  }

  return true;
}

async function main() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Simple REST wrappers around the same in-memory todo store used by the MCP tools.
  app.get("/api/todos", (_req, res) => {
    res.json(listTodoItems());
  });

  app.post("/api/todos", (req, res) => {
    const item = typeof req.body?.item === "string" ? req.body.item.trim() : "";
    if (!item) {
      res.status(400).json({ error: "invalid_request", error_description: "item is required" });
      return;
    }
    const todo = createTodoItem(item);
    res.status(201).json(todo);
  });

  app.patch("/api/todos/:id", (req, res) => {
    const id = String(req.params.id || "");
    const isComplete = Boolean(req.body?.isComplete);
    const todo = updateTodoItem(id, isComplete);
    if (!todo) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(todo);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (req, res) => {
    const issuer = issuerFor(req);
    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP Todo Server</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; }
      main { max-width: 720px; margin: 0 auto; }
      h1 { margin: 0 0 8px; }
      h2 { margin: 20px 0 8px; font-size: 1.1rem; }
      p { margin: 8px 0; opacity: 0.9; }
      section { border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; padding: 16px; margin: 16px 0; }
      form { display: flex; gap: 8px; margin: 8px 0 12px; }
      input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.35); }
      button { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.35); background: transparent; cursor: pointer; }
      ul { padding-left: 18px; margin: 8px 0; }
      #todoList { list-style: none; padding-left: 0; }
      #todoList li { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; }
      #todoList li:hover { background: rgba(127,127,127,0.08); }
      a { color: inherit; }
      code { padding: 2px 6px; border-radius: 6px; background: rgba(127,127,127,0.12); }
    </style>
  </head>
  <body>
    <main>
      <h1>MCP Todo Server</h1>
      <p>Server is running.</p>
      <section>
        <h2>Todos</h2>
        <form id="createTodoForm">
          <input id="newTodoText" name="item" placeholder="New todo" required />
          <button type="submit">Add</button>
        </form>
        <ul id="todoList"></ul>
      </section>
      <ul>
        <li><a href="/health">/health</a></li>
        <li><a href="/api/todos">/api/todos</a></li>
        <li><a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></li>
        <li><a href="/.well-known/openid-configuration">/.well-known/openid-configuration</a></li>
      </ul>
      <p><strong>Issuer:</strong> ${issuer}</p>
      <script>
        async function refreshTodos() {
          const res = await fetch('/api/todos');
          const todos = await res.json();
          const list = document.getElementById('todoList');
          list.replaceChildren();
          for (const t of todos) {
            const li = document.createElement('li');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = Boolean(t.isComplete);
            cb.addEventListener('change', async () => {
              await fetch('/api/todos/' + encodeURIComponent(t.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isComplete: cb.checked }),
              });
              refreshTodos();
            });
            const text = document.createElement('span');
            text.textContent = ' ' + t.item;
            li.appendChild(cb);
            li.appendChild(text);
            list.appendChild(li);
          }
        }

        document.getElementById('createTodoForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const input = document.getElementById('newTodoText');
          const item = input.value.trim();
          if (!item) return;
          await fetch('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item }),
          });
          input.value = '';
          refreshTodos();
        });

        refreshTodos();
      </script>
    </main>
  </body>
</html>`);
  });

  // Store transports by session ID (one per /sse connection)
  const transports: Record<string, SSEServerTransport> = {};

  // OAuth / OIDC discovery endpoints (these are what ChatGPT is probing)
  // Serve them both at root and under /sse/* because some clients probe relative to the MCP URL.
  app.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/sse",
      "/sse/.well-known/oauth-authorization-server",
      "/sse/.well-known/oauth-authorization-server/sse",
    ],
    (req, res) => {
      res.json(oauthMetadata(req));
    }
  );

  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/sse",
      "/sse/.well-known/oauth-protected-resource",
      "/sse/.well-known/oauth-protected-resource/sse",
    ],
    (req, res) => {
      res.json(protectedResourceMetadata(req));
    }
  );

  // Some clients also probe OIDC discovery; we return a minimal superset pointing to OAuth endpoints.
  app.get(
    [
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration/sse",
      "/sse/.well-known/openid-configuration",
      "/sse/.well-known/openid-configuration/sse",
    ],
    (req, res) => {
      const meta = oauthMetadata(req);
      res.json({
        ...meta,
        jwks_uri: `${meta.issuer}/jwks`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
  );

  app.get("/jwks", (_req, res) => {
    // We don't issue ID tokens in this POC. Kept only so OIDC discovery doesn't 404.
    res.json({ keys: [] });
  });

  // RFC 7591 Dynamic Client Registration (open registration, POC)
  // ChatGPT can call this to obtain a client_id (and optionally a client_secret).
  app.post("/register", (req, res) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : null;

    if (!redirectUris || redirectUris.length === 0 || !redirectUris.every((u: unknown) => typeof u === "string")) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of strings",
      });
      return;
    }

    const requestedMethod = String(body.token_endpoint_auth_method || "none") as TokenEndpointAuthMethod;
    const tokenEndpointAuthMethod: TokenEndpointAuthMethod =
      requestedMethod === "client_secret_basic" || requestedMethod === "client_secret_post" || requestedMethod === "none"
        ? requestedMethod
        : "none";

    const clientId = base64UrlEncode(crypto.randomBytes(18));
    const issuedAtSec = Math.floor(Date.now() / 1000);

    let clientSecret: string | undefined;
    let clientSecretExpiresAtSec: number | undefined;
    if (tokenEndpointAuthMethod !== "none") {
      clientSecret = base64UrlEncode(crypto.randomBytes(24));
      clientSecretExpiresAtSec = 0;
    }

    const record: ClientRecord = {
      clientId,
      redirectUris,
      tokenEndpointAuthMethod,
      clientName: typeof body.client_name === "string" ? body.client_name : undefined,
      clientSecret,
      clientIdIssuedAtSec: issuedAtSec,
      clientSecretExpiresAtSec,
    };

    clients.set(clientId, record);

    const response: Record<string, unknown> = {
      client_id: record.clientId,
      client_id_issued_at: record.clientIdIssuedAtSec,
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: record.tokenEndpointAuthMethod,
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };

    if (record.clientName) response.client_name = record.clientName;
    if (record.clientSecret) {
      response.client_secret = record.clientSecret;
      response.client_secret_expires_at = record.clientSecretExpiresAtSec ?? 0;
    }

    res.status(201).json(response);
  });

  // Minimal OAuth2 Authorization Code + PKCE (S256)
  // No UI/login: auto-approves and immediately redirects with a code.
  app.get("/oauth/authorize", (req, res) => {
    const responseType = String(req.query.response_type || "");
    const clientId = String(req.query.client_id || "");
    const redirectUri = String(req.query.redirect_uri || "");
    const state = String(req.query.state || "");
    const codeChallenge = String(req.query.code_challenge || "");
    const codeChallengeMethod = String(req.query.code_challenge_method || "");

    if (responseType !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (!clientId) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing client_id" });
      return;
    }
    const client = getClient(clientId);
    if (!client) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    if (!redirectUri) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing redirect_uri" });
      return;
    }
    if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }

    // PKCE required
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      res.status(400).json({
        error: "invalid_request",
        error_description: "PKCE required: provide code_challenge and code_challenge_method=S256",
      });
      return;
    }

    const code = base64UrlEncode(crypto.randomBytes(24));
    authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      expiresAtMs: Date.now() + 5 * 60 * 1000,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.post("/oauth/token", (req, res) => {
    const grantType = String(req.body.grant_type || "");
    const code = String(req.body.code || "");
    const redirectUri = String(req.body.redirect_uri || "");
    const codeVerifier = String(req.body.code_verifier || "");

    const basic = parseBasicAuth(req);
    const clientId = String(basic?.username || req.body.client_id || "");
    const clientSecret = String(basic?.password || req.body.client_secret || "");

    if (grantType !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code" });
      return;
    }
    if (!clientId) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing client_id" });
      return;
    }
    const client = getClient(clientId);
    if (!client) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!clientSecret || !client.clientSecret || !constantTimeEqual(clientSecret, client.clientSecret)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
    }

    const record = authCodes.get(code);
    if (!record) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (Date.now() >= record.expiresAtMs) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (record.clientId !== clientId) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (!codeVerifier) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code_verifier" });
      return;
    }
    const computedChallenge = pkceS256(codeVerifier);
    if (computedChallenge !== record.codeChallenge) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // One-time use
    authCodes.delete(code);

    const accessToken = base64UrlEncode(crypto.randomBytes(32));
    accessTokens.set(accessToken, {
      clientId,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    });

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  // MCP SSE endpoint
  app.get("/sse", async (req, res) => {
    if (!requireAuth(req, res)) return;

    try {
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      transports[sessionId] = transport;

      transport.onclose = () => {
        delete transports[sessionId];
      };

      const server = createServer();
      await server.connect(transport);
    } catch (error) {
      if (!res.headersSent) res.status(500).send("Error establishing SSE stream");
    }
  });

  // Some clients mistakenly POST to /sse; the MCP transport expects POST /messages?sessionId=...
  app.post("/sse", (_req, res) => {
    res.status(405).json({
      error: "method_not_allowed",
      error_description: "Use GET /sse for the SSE stream, then POST /messages?sessionId=... for MCP messages.",
    });
  });

  // MCP message POST endpoint
  app.post("/messages", async (req, res) => {
    if (!requireAuth(req, res)) return;

    const sessionId = String(req.query.sessionId || "");
    if (!sessionId) {
      res.status(400).send("Missing sessionId parameter");
      return;
    }
    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).send("Error handling request");
    }
  });

  app.listen(PORT, () => {
    console.error(`Todo MCP Server listening on port ${PORT}`);
    console.error(
      OAUTH_REQUIRED
        ? "Auth: enabled (OAuth PKCE + Bearer required)"
        : MCP_BEARER_TOKEN
          ? "Auth: enabled (static MCP_BEARER_TOKEN)"
          : "Auth: disabled"
    );
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

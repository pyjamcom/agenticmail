#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toolDefinitions, handleToolCall } from './tools.js';
import { resourceDefinitions, handleResourceRead } from './resources.js';
import { setTelemetryVersion } from '@agenticmail/core';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z, type ZodTypeAny } from 'zod';

setTelemetryVersion('0.5.55');

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema | undefined>;
  required?: string[];
  items?: JsonSchema;
};

function jsonSchemaToZod(schema: JsonSchema | undefined, topLevel = false): Record<string, ZodTypeAny> | ZodTypeAny {
  if (!schema || typeof schema !== 'object') return topLevel ? {} : z.any();

  let result: ZodTypeAny;
  if (schema.type === 'string') {
    result = schema.enum?.length ? z.enum(schema.enum as [string, ...string[]]) : z.string();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    result = z.number();
  } else if (schema.type === 'boolean') {
    result = z.boolean();
  } else if (schema.type === 'array') {
    // When `items` is missing or empty, default to `z.any()` so the
    // tool still accepts heterogeneous arrays at runtime — several
    // existing tools pass arrays of objects without an items
    // declaration (db_admin's columns/rows/operations etc.) and a
    // string-only fallback would silently reject them. Strict
    // OpenAI-compatible validators still want explicit items
    // upstream — those are now declared per-field in tools.ts so
    // the runtime fallback is just defence-in-depth for new tools.
    const hasItems = !!schema.items && typeof schema.items === 'object' && Object.keys(schema.items).length > 0;
    result = z.array(hasItems ? jsonSchemaToZod(schema.items, false) as ZodTypeAny : z.any());
  } else if (schema.type === 'object') {
    // Free-form object (no declared properties) → z.record(z.any())
    // so callers can pass arbitrary keys. db_admin's `where`,
    // `set`, and `column` are all free-form by design — turning
    // them into z.object({}) would reject every real call.
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      if (topLevel) return {};
      result = z.record(z.string(), z.any());
    } else {
      const shape: Record<string, ZodTypeAny> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, prop] of Object.entries(schema.properties)) {
        let child = jsonSchemaToZod(prop, false) as ZodTypeAny;
        if (!required.has(key)) child = child.optional();
        shape[key] = child;
      }
      if (topLevel) return shape;
      result = z.object(shape);
    }
  } else {
    result = z.any();
  }

  return schema.description ? result.describe(schema.description) : result;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: '🎀 AgenticMail',
    version: '0.2.27',
    description: '🎀 AgenticMail — Email infrastructure for AI agents. By Ope Olatunji (https://github.com/agenticmail/agenticmail)',
  } as any);

  // Register tools.
  //
  // Every tool's input schema is augmented with an optional `_account` param
  // so callers can override the identity used for that single call (see
  // tools.ts → handleToolCall). Without this augmentation, Zod's default
  // "strip unknown keys" behaviour would drop `_account` before our handler
  // ever saw it — which silently degrades back to the static API_KEY and
  // makes the per-call account switching look like a no-op. Augmenting the
  // schema (rather than swapping to `z.record(z.any())` or `.passthrough()`)
  // also has the nice side effect of making `_account` discoverable in the
  // tool surface that the MCP client publishes to the LLM.
  const ACCOUNT_PROP = {
    type: 'string',
    description: 'Optional. Override identity for THIS call: pass the AgenticMail agent name (e.g. "Fola") to authenticate as that agent. Requires AGENTICMAIL_ACCOUNT_KEYS_JSON to contain a matching key. Omit to use the default identity (AGENTICMAIL_API_KEY).',
  } as const;

  for (const tool of toolDefinitions) {
    const augmentedSchema: JsonSchema = {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema?.properties ?? {}),
        _account: ACCOUNT_PROP,
      },
    };
    server.tool(
      tool.name,
      tool.description,
      jsonSchemaToZod(augmentedSchema, true) as any,
      async (args: Record<string, unknown>) => {
        try {
          const result = await handleToolCall(tool.name, args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: result }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  // Register resources
  for (const resource of resourceDefinitions) {
    server.resource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async () => {
        try {
          const content = await handleResourceRead(resource.uri);
          return {
            contents: [{ uri: resource.uri, text: content, mimeType: resource.mimeType }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            contents: [{ uri: resource.uri, text: `Error: ${message}`, mimeType: 'text/plain' }],
          };
        }
      },
    );
  }

  return server;
}

// Parse CLI args
const args = process.argv.slice(2);
const httpFlag = args.includes('--http');
const portArg = args.find(a => a.startsWith('--port='));
const httpPort = portArg ? parseInt(portArg.split('=')[1], 10) : (parseInt(process.env.MCP_PORT || '', 10) || 8014);

if (httpFlag || process.env.MCP_HTTP === '1') {
  // ─── HTTP/Streamable HTTP Transport ───────────────────────────────
  // Supports both SSE streaming and direct JSON responses per MCP spec.
  // Usage: agenticmail-mcp --http [--port=8014]
  const server = createMcpServer();

  // Map of session ID -> transport for stateful connections
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${httpPort}`);
    const path = url.pathname;

    // Health check
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', sessions: transports.size }));
      return;
    }

    // Only handle /mcp endpoint
    if (path !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is POST /mcp' }));
      return;
    }

    // Handle DELETE for session termination
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      }
      return;
    }

    // Handle GET for SSE stream (session resumption)
    if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID for SSE stream. Send a POST /mcp with initialize first.' }));
      }
      return;
    }

    // Handle POST for JSON-RPC messages
    if (req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session — create transport and connect
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) transports.delete(sid);
      };

      // Connect a new server instance per session
      const sessionServer = createMcpServer();
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // Other methods
    res.writeHead(405, { 'Allow': 'GET, POST, DELETE', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST /mcp for JSON-RPC, GET /mcp for SSE stream.' }));
  });

  httpServer.listen(httpPort, () => {
    console.log(`🎀 AgenticMail MCP Server (Streamable HTTP)`);
    console.log(`   Endpoint: http://localhost:${httpPort}/mcp`);
    console.log(`   Health:   http://localhost:${httpPort}/health`);
    console.log(`   Transport: Streamable HTTP (SSE + JSON responses)`);
  });

  // Graceful shutdown
  async function shutdown() {
    for (const transport of transports.values()) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());

} else {
  // ─── Stdio Transport (default) ────────────────────────────────────
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    console.error('[agenticmail-mcp] Failed to start:', err);
    process.exit(1);
  }

  async function shutdown() {
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

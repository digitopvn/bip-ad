import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { z } from 'zod';
import { DomainError } from '../domain/errors';

type Shape = Record<string, z.ZodType>;

/** Register a tool whose handler returns JSON. Domain errors become MCP tool errors with an HTTP-like status (403 for foreign resources). */
export function jsonTool<S extends Shape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  readOnly: boolean,
  handler: (args: { [K in keyof S]: z.infer<S[K]> }) => Promise<unknown>,
) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, (async (args: { [K in keyof S]: z.infer<S[K]> }) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      const err = e instanceof DomainError ? { status: e.status, code: e.code, message: e.message } : { status: 500, code: 'internal', message: 'Internal error' };
      if (!(e instanceof DomainError)) console.error(`mcp tool ${name} failed`, e);
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: err }) }] };
    }
  }) as never);
}

/** Stateless Streamable HTTP: a fresh server + transport per request, JSON responses. */
export async function serveMcp(server: McpServer, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

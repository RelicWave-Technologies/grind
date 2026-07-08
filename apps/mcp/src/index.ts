#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TimoClient } from './client';
import { loadConfig } from './config';
import { registerTimoTools } from './tools';

async function main() {
  const config = loadConfig();
  const server = new McpServer({
    name: 'timo',
    version: '0.1.0',
  });
  registerTimoTools(server, new TimoClient(config));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[timo-mcp] ${message}`);
  process.exit(1);
});

#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TimoClient } from './client';
import { loadConfig } from './config';
import { registerTimoTools } from './tools';

/**
 * The version clients see comes from package.json, so a release bump can't
 * leave the server announcing a stale one. `../package.json` resolves the same
 * from src/ (tsx dev) and dist/ (published bundle; npm always ships
 * package.json). The bundle is CJS, where `require` exists; the ESM dev path
 * builds one from import.meta.url.
 */
function packageVersion(): string {
  try {
    const load = typeof require === 'function' ? require : createRequire(import.meta.url);
    const pkg = load('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main() {
  const config = loadConfig();
  const server = new McpServer({
    name: 'timo',
    version: packageVersion(),
  });
  registerTimoTools(server, new TimoClient(config));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[timo-mcp] ${message}`);
  process.exit(1);
});

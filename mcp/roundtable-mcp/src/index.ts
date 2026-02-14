#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { createRoundtableMcpServer } from './server.js';
import { runHttpMcpServer } from './http.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

function hasArg(name: string): boolean {
  return process.argv.slice(2).some((a) => a === name);
}

async function runStdio(): Promise<void> {
  const server = createRoundtableMcpServer({ version: pkg.version, mode: 'stdio' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const envTransport = (process.env.MCP_TRANSPORT || '').trim().toLowerCase();
  const useHttp = hasArg('--http') || envTransport === 'http';
  if (useHttp) {
    await runHttpMcpServer({ version: pkg.version });
    return;
  }

  await runStdio();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('roundtable-mcp fatal:', err);
  process.exit(1);
});


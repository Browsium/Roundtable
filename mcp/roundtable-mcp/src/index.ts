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
  // When running inside a remote container (ex: Docker MCP Gateway), STDIO transport is still used,
  // but we want "remote-friendly" semantics: no local file_path access, and exports returned as blobs.
  const remoteHint = (process.env.ROUNDTABLE_MCP_REMOTE || '').trim().toLowerCase();
  const isRemote = remoteHint === '1' || remoteHint === 'true' || remoteHint === 'yes';
  const server = createRoundtableMcpServer({ version: pkg.version, mode: isRemote ? 'http' : 'stdio' });
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

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config } from './lib/config.mjs';
import { api, log } from './lib/api.mjs';

async function main() {
  const body = {
    name: config.runnerName,
    platform: config.runnerPlatform,
    capabilities: ['git', 'docker', 'http', config.agent],
  };
  const result = await api('/runners/register', { method: 'POST', body });
  const id = result.id;
  fs.writeFileSync(config.stateFile, JSON.stringify({ id }, null, 2), 'utf8');
  log(`Runner 注册成功：${id}`);
  log(`运行：node runner/runner.mjs（AGENT=${config.agent}）`);
}

main().catch((error) => {
  console.error(`注册失败：${error.stack || error.message}`);
  process.exit(1);
});

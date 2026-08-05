#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🚀 开始构建桌面应用...');

// 1. 构建Web应用
console.log('📦 构建Web应用...');
execSync('npm run build', { stdio: 'inherit' });

// 2. Electron sources are committed under electron/ (main.js, preload.js, mcpLocalServer.js).
// Do NOT overwrite them with a generated shell — MCP + preload require first-class sources.
const electronDir = path.join(__dirname, '../electron');
const required = ['main.js', 'preload.js', 'mcpLocalServer.js', 'package.json'];
for (const file of required) {
  const p = path.join(electronDir, file);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing required Electron file: electron/${file}`);
    process.exit(1);
  }
}
console.log('⚡ 使用已提交的 electron/ 源码（含 MCP 与 preload）');

// 3. Verify Electron dependencies. They are installed by the project package manager.
console.log('🔎 检查Electron依赖...');
try {
  execSync('npm ls electron electron-builder --depth=0', { stdio: 'inherit' });
} catch (error) {
  console.error('缺少 Electron 依赖。请先执行 npm install。', error.message);
  process.exit(1);
}

// 4. 构建应用
console.log('🔨 构建桌面应用...');
try {
  execSync('npx electron-builder', { stdio: 'inherit' });
  const releaseDir = path.join(__dirname, '../release');
  const installer = fs.readdirSync(releaseDir)
    .filter((file) => file.endsWith('.exe') && !file.includes('unpacked'))
    .sort()
    .at(-1);
  if (!installer) throw new Error('未找到 Windows 安装程序。');
  const target = path.join(__dirname, '..', 'HotChasing-Setup.exe');
  fs.copyFileSync(path.join(releaseDir, installer), target);
  console.log('✅ 桌面应用构建完成！');
  console.log(`📁 安装程序：${target}`);
} catch (error) {
  console.error('构建失败:', error.message);
  process.exit(1);
}

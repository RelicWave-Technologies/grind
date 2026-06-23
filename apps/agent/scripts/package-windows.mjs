#!/usr/bin/env node
// Package the Windows installer via a `pnpm deploy` staging dir.
//
// This mirrors package-mac.sh because the pnpm workspace hoists production
// transitive dependencies in ways electron-builder can miss from the monorepo
// tree. The deploy staging dir gives electron-builder a flat app-local
// node_modules tree.
//
// Usage:
//   node scripts/package-windows.mjs [x64]
// Env:
//   SIGN=1   allow electron-builder to sign using WIN_CSC_LINK / CSC_LINK.
//            Default is unsigned, which is expected for v1 internal Windows IT.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arch = process.argv[2] || 'x64';
if (arch !== 'x64') {
  console.error(`Unsupported Windows arch "${arch}". Use x64 for the v1 Windows build.`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, '..');
const rootDir = path.resolve(agentDir, '../..');
const defaultStage =
  process.platform === 'win32'
    ? path.join(rootDir, '.tmp', 'grind-agent-win-deploy')
    : path.join(os.tmpdir(), 'grind-agent-win-deploy');
const stage = process.env.STAGE_DIR || defaultStage;
const electronVersion = '33.2.0';

function bin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(cmd, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(cmd), args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function copyIfExists(src, dest) {
  try {
    await fs.cp(src, dest, { recursive: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.warn(
      '> warning: building Windows from a non-Windows host can fail for native modules; ' +
        'use the Package Windows Agent workflow or a Windows machine for release artifacts.',
    );
  }

  console.log('> electron-vite build (bakes MAIN_VITE_API_URL from .env.production)');
  await run('pnpm', ['--filter', '@grind/agent', 'exec', 'electron-vite', 'build'], rootDir);

  console.log(`> pnpm deploy --prod -> ${stage}`);
  await fs.rm(stage, { recursive: true, force: true });
  await run('pnpm', ['--filter', '@grind/agent', 'deploy', '--prod', stage], rootDir);

  console.log('> staging out/ + build resources + config into deploy dir');
  await copyIfExists(path.join(agentDir, 'out'), path.join(stage, 'out'));
  await copyIfExists(path.join(agentDir, 'build'), path.join(stage, 'build'));
  await fs.copyFile(path.join(agentDir, 'electron-builder.yml'), path.join(stage, 'electron-builder.yml'));

  const builderArgs = [
    'exec',
    'electron-builder',
    '--win',
    'nsis',
    `--${arch}`,
    '--projectDir',
    stage,
    `-c.electronVersion=${electronVersion}`,
    `-c.afterPack=${path.join(stage, 'build', 'afterPack.cjs')}`,
  ];

  if (process.platform === 'win32') {
    console.log('> rebuilding Electron native dependency: better-sqlite3');
    await run(
      'pnpm',
      [
        '--filter',
        '@grind/agent',
        'exec',
        'electron-rebuild',
        '--version',
        electronVersion,
        '--module-dir',
        stage,
        '--arch',
        arch,
        '--only',
        'better-sqlite3',
        '--force',
      ],
      rootDir,
    );
    builderArgs.push('-c.npmRebuild=false');
  }

  const env = {};
  if (process.env.SIGN !== '1') {
    console.log('> unsigned Windows build (set SIGN=1 + WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD to sign)');
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    builderArgs.push('-c.win.sign=false');
  } else {
    console.log('> signed Windows build');
  }

  await run('pnpm', builderArgs, rootDir, env);

  const srcRelease = path.join(stage, 'release');
  const destRelease = path.join(agentDir, 'release');
  await fs.mkdir(destRelease, { recursive: true });
  const copied = [];
  for (const entry of await fs.readdir(srcRelease, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const src = path.join(srcRelease, entry.name);
    const dest = path.join(destRelease, entry.name);
    await fs.copyFile(src, dest);
    copied.push(dest);
  }

  console.log(`✓ Windows artifacts -> ${destRelease}`);
  for (const file of copied) {
    const stat = await fs.stat(file);
    console.log(`  ${path.basename(file)} ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

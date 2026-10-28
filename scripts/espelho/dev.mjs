#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { URI, BACK_DIR } from './config.mjs';
import { buildMirrorEnvironment } from './environment.mjs';

const env = buildMirrorEnvironment(process.env, URI);
const guard = fileURLToPath(new URL('./runtime-guard.cjs', import.meta.url));
console.log('[dev:espelho] Mongo local /fono_espelho; Redis exclusivo 127.0.0.1:6381; rede externa bloqueada.');
const child = spawn(process.execPath, ['--dns-result-order=ipv4first', '--max-old-space-size=2048', '--require', guard, 'server.js'], {
  cwd: BACK_DIR, env, stdio: 'inherit', windowsHide: true,
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));

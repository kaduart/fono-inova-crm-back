import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import Redis from 'ioredis';

const backend = fileURLToPath(new URL('../', import.meta.url));
process.chdir(backend);
dotenv.config({ path: path.join(backend, '.env') });
const options = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  retryStrategy: () => null,
  connectTimeout: 1000,
  commandTimeout: 1000,
};

async function ping() {
  const client = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
      lazyConnect: true, retryStrategy: () => null,
      connectTimeout: 1000, commandTimeout: 1000,
    })
    : new Redis(options);
  client.on('error', () => {});
  try {
    await client.connect();
    return await client.ping() === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

async function ensureRedis() {
  if (await ping()) return;
  const endpoint = process.env.REDIS_URL ? new URL(process.env.REDIS_URL) : null;
  const host = endpoint?.hostname || options.host;
  const port = Number(endpoint?.port || (endpoint ? 6379 : options.port));
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error('Redis remoto indisponivel. Verifique a conexao e a configuracao REDIS_URL.');
  }
  const executable = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Memurai', 'memurai.exe')
    : 'redis-server';
  if (process.platform === 'win32' && !existsSync(executable)) {
    throw new Error('Memurai nao encontrado em Program Files. Instale-o para iniciar o Redis local.');
  }
  // Keep local queue data across restarts, in a user-writable directory.
  const dataDir = path.join(backend, '.local', 'redis');
  mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, 'redis.log');
  const log = openSync(logPath, 'a');
  console.log('[dev] Iniciando Redis local...');
  let launchError;
  const child = spawn(executable, [
    '--bind', host.replaceAll('[', '').replaceAll(']', ''), '--port', String(port),
    '--dir', dataDir, '--appendonly', 'yes',
  ], { cwd: dataDir, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.on('error', (error) => { launchError = error; });
  child.unref();
  closeSync(log);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (launchError) throw new Error(`Nao foi possivel iniciar ${executable}: ${launchError.code}`);
    if (await ping()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Redis nao respondeu. Consulte ${logPath} e confira as credenciais Redis do .env.`);
}

try {
  await ensureRedis();
  console.log('[dev] Redis pronto.');
  if (!process.argv.includes('--check')) {
    const require = createRequire(import.meta.url);
    const child = spawn(process.execPath, [
      '--dns-result-order=ipv4first', '--max-old-space-size=2048',
      require.resolve('nodemon/bin/nodemon.js'), '-r', 'dotenv/config', 'server.js',
    ], { cwd: backend, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 0; });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => child.kill(signal));
    }
  }
} catch (error) {
  console.error(`[dev] ${error.message}`);
  process.exitCode = 1;
}

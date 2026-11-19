// Preload de teste (node --import): registra cada módulo do repositório carregado pelo processo e troca o
// child_process.fork por um falso que só anota o caminho pedido (nenhum processo filho, nenhum Chrome).
// Saída: JSON em process.env.WA_BOOT_RECORD (sobrescrito a cada evento).
import { register, syncBuiltinESMExports } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import cp from 'node:child_process';
import fs from 'node:fs';

const out = process.env.WA_BOOT_RECORD;
const rec = { loaded: [], forks: [], childMessages: [] };
const flush = () => { try { fs.writeFileSync(out, JSON.stringify(rec)); } catch { /* */ } };

const { port1, port2 } = new MessageChannel();
port1.on('message', (url) => { rec.loaded.push(url); flush(); });
port1.unref();
register('data:text/javascript,' + encodeURIComponent(`
  let port;
  export function initialize(d) { port = d.port; }
  export async function load(url, ctx, next) { if (url.startsWith('file:')) port.postMessage(url); return next(url, ctx); }
`), { data: { port: port2 }, transferList: [port2] });

cp.fork = (modulePath, args, opts) => {
  rec.forks.push(String(modulePath));
  flush();
  const child = new EventEmitter();
  child.pid = 999999;
  child.connected = true;
  child.send = (msg) => { rec.childMessages.push(msg); flush(); return true; };
  child.kill = () => true;
  return child;
};
syncBuiltinESMExports();
flush();

// whatsapp-connector/src/sessionGuard.js
//
// Proteção da sessão do WhatsApp no disco do conector:
//  1. Pasta privada: a sessão (perfil do Chrome com as chaves do aparelho vinculado) e os dados do conector
//     ficam em pastas 0700 do próprio usuário do processo. Se a permissão estiver aberta, corrige; se a pasta
//     for de outro usuário, recusa subir.
//  2. Trava exclusiva: um único processo por pasta de sessão. O arquivo .connector-lock.json é criado com
//     O_EXCL. Trava de um processo morto NESTE host é retomada; trava de um processo vivo, recusa. Trava de
//     OUTRO host (pasta copiada ou disco compartilhado) nunca é retomada sozinha: só com
//     WA_SESSION_TAKEOVER=<host que está na trava>, depois de conferir que o outro host parou.
//  3. Marcador de transferência: .session-transferred.json, gravado quando a sessão é exportada para outro
//     lugar. Com ele, o conector também recusa subir (a mesma sessão não pode rodar em dois lugares).

import fs from 'fs';
import os from 'os';
import path from 'path';

export const LOCK_FILE = '.connector-lock.json';
export const TRANSFERRED_MARKER = '.session-transferred.json';

export class SessionGuardError extends Error {
  constructor(message, code) { super(message); this.name = 'SessionGuardError'; this.code = code; }
}

/** Cria (se preciso) e garante pasta 0700 do usuário atual. Devolve o que foi corrigido. */
export function ensurePrivateDir(dir, { uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new SessionGuardError(`${dir} não é pasta`, 'NOT_A_DIR');
  if (uid !== null && st.uid !== uid) {
    throw new SessionGuardError(`${dir} pertence a outro usuário (uid ${st.uid}); o conector roda como ${uid}`, 'WRONG_OWNER');
  }
  const fixed = (st.mode & 0o077) !== 0;
  if (fixed) fs.chmodSync(dir, 0o700);
  if ((fs.statSync(dir).mode & 0o077) !== 0) throw new SessionGuardError(`não consegui fechar a permissão de ${dir}`, 'PERMS');
  return { dir, fixed };
}

const defaultIsAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * Pega a trava da pasta de sessão. Devolve { release(), info, recovered }.
 * @param {{ authPath: string, connectorId?: string, hostname?: string, pid?: number,
 *           isAlive?: (pid:number)=>boolean, takeoverHost?: string|null, now?: ()=>number }} o
 */
export function acquireSessionLock({
  authPath, connectorId = 'main', hostname = os.hostname(), pid = process.pid,
  isAlive = defaultIsAlive, takeoverHost = null, now = () => Date.now(),
}) {
  const marker = path.join(authPath, TRANSFERRED_MARKER);
  if (fs.existsSync(marker)) {
    let info = {};
    try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* conteúdo ilegível ainda bloqueia */ }
    throw new SessionGuardError(
      `sessão marcada como transferida (${info.to || '?'} em ${info.at || '?'}); apague ${TRANSFERRED_MARKER} só depois de parar o outro lado`,
      'TRANSFERRED',
    );
  }
  const file = path.join(authPath, LOCK_FILE);
  const info = { connectorId, hostname, pid, startedAt: new Date(now()).toISOString() };
  let recovered = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      return {
        info,
        recovered,
        release() {
          try {
            const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (cur.pid === pid && cur.hostname === hostname) fs.unlinkSync(file);
          } catch { /* já liberada */ }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; }
      if (!held) {
        throw new SessionGuardError(`trava ilegível em ${file}; confira se outro processo usa a sessão e apague o arquivo`, 'LOCK_UNREADABLE');
      }
      const sameHost = held.hostname === hostname;
      if (sameHost && held.pid !== pid && isAlive(held.pid)) {
        throw new SessionGuardError(`sessão em uso pelo processo ${held.pid} neste host (desde ${held.startedAt})`, 'LOCKED');
      }
      if (!sameHost && takeoverHost !== held.hostname) {
        throw new SessionGuardError(
          `sessão travada pelo host ${held.hostname} (pid ${held.pid}, desde ${held.startedAt}). Se ele parou de vez, `
          + `suba com WA_SESSION_TAKEOVER=${held.hostname}`,
          'LOCKED_OTHER_HOST',
        );
      }
      recovered = held; // processo morto neste host, ou retomada autorizada do outro host
      fs.unlinkSync(file);
    }
  }
  throw new SessionGuardError('não consegui pegar a trava da sessão', 'LOCK_RACE');
}

export default { ensurePrivateDir, acquireSessionLock, SessionGuardError, LOCK_FILE, TRANSFERRED_MARKER };

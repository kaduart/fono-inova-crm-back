// whatsapp-connector/src/procMem.js
// Memória de uma árvore de processos (o Chrome abre vários: browser, renderer, gpu, utility) lendo /proc.
// RSS soma páginas compartilhadas mais de uma vez; PSS (smaps_rollup) divide o compartilhado e é o número
// mais honesto para "quanto este conjunto ocupa". Só Linux; fora dele devolve null.

import fs from 'fs';

function readStatus(pid) {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const get = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(txt); return m ? Number(m[1]) : 0; };
    const name = /^Name:\s+(.+)$/m.exec(txt)?.[1] || '?';
    return { pid, ppid: get('PPid'), rssKb: get('VmRSS'), name };
  } catch { return null; }
}

function readPssKb(pid) {
  try {
    const m = /^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** Todos os descendentes de rootPid (inclusive), com RSS e PSS em MB. */
export function processTreeMemory(rootPid) {
  if (!rootPid || !fs.existsSync('/proc')) return null;
  const all = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const s = readStatus(Number(d));
    if (s) all.push(s);
  }
  const children = new Map();
  for (const p of all) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const root = all.find((p) => p.pid === rootPid);
  if (!root) return null;
  const tree = [];
  const stack = [root];
  while (stack.length) { const p = stack.pop(); tree.push(p); stack.push(...(children.get(p.pid) || [])); }
  let rssKb = 0; let pssKb = 0; let pssOk = true;
  const procs = tree.map((p) => {
    const pss = readPssKb(p.pid);
    if (pss === null) pssOk = false; else pssKb += pss;
    rssKb += p.rssKb;
    return { pid: p.pid, name: p.name, rssMB: Math.round(p.rssKb / 1024), pssMB: pss === null ? null : Math.round(pss / 1024) };
  });
  return { processes: procs.length, rssMB: Math.round(rssKb / 1024), pssMB: pssOk ? Math.round(pssKb / 1024) : null, procs };
}

/** cgroup v2 do container (memória que o provedor cobra/limita). */
export function cgroupMemoryMB() {
  try { return Math.round(Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) / 1048576); } catch { return null; }
}

export default { processTreeMemory, cgroupMemoryMB };

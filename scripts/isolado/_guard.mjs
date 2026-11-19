// scripts/isolado/_guard.mjs
// Trava dos processos do ambiente integrado CRM + KAS: só sobe contra MongoDB
// e Redis em loopback e banco com prefixo "isolado_". Nunca lê .env.
export function die(msg) {
  console.error(`[isolado] RECUSADO: ${msg}`);
  process.exit(2);
}

function isLoopback(host) {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

export function requireIsolatedMongo(envName = 'CRM_ISOLADO_MONGO_URI') {
  const uri = process.env[envName];
  if (!uri) die(`${envName} não definida`);
  if (uri.startsWith('mongodb+srv://')) die('URI +srv (Atlas) não é permitida');
  let u;
  try { u = new URL(uri); } catch { die(`${envName} inválida`); }
  for (const hp of u.host.split(',')) {
    const host = hp.startsWith('[') ? hp.slice(0, hp.indexOf(']') + 1) : hp.split(':')[0];
    if (!isLoopback(host)) die('MongoDB fora de loopback');
  }
  const db = u.pathname.replace(/^\//, '');
  if (!db.startsWith('isolado_')) die('o banco precisa começar com "isolado_"');
  return { uri, db };
}

export function requireIsolatedRedis(envName = 'REDIS_URL') {
  const url = process.env[envName];
  if (!url) die(`${envName} não definida`);
  let u;
  try { u = new URL(url); } catch { die(`${envName} inválida`); }
  if (!isLoopback(u.hostname)) die('Redis fora de loopback');
  return url;
}

export function requireLocalUrl(envName) {
  const url = process.env[envName];
  if (!url) return null;
  const u = new URL(url);
  if (!isLoopback(u.hostname)) die(`${envName} fora de loopback`);
  return url;
}

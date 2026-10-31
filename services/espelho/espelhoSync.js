// services/espelho/espelhoSync.js
/**
 * 🪞 Núcleo da cópia PRODUÇÃO → DEV na nuvem. Usado pelo cron (crons/espelhoSync.cron.js)
 * e pelo CLI (scripts/espelho/sync-nuvem.mjs). Doc: docs/ESPELHO_SYNC.md
 *
 * Garantias:
 *  - Produção: lida SÓ com PROD_URI_READONLY. Nada é escrito lá.
 *  - Escrita: SÓ no banco ESPELHO_SYNC_TARGET_DB do cluster ESPELHO_SYNC_TARGET_URI, que é
 *    recusado se estiver no host do MONGO_URI/PROD_URI_READONLY ou tiver "prod" no nome.
 *  - Troca segura: copia para coleções "__novo__*", valida, e só então substitui. Se falhar
 *    antes da troca, a cópia anterior fica intacta. Se falhar NA troca, o estado fica marcado
 *    "inconsistente" no _espelho_controle e a próxima execução refaz tudo.
 *  - Sem execuções simultâneas: trava no próprio banco de destino (+ lock Redis quando houver).
 *  - Pausa: ESPELHO_SYNC_PAUSED=true OU _espelho_controle {_id:'controle', pausado:true}.
 *  - Sempre anonimiza (pacientes, leads e equipe), zera tokens/segredos e troca e-mail/senha
 *    da equipe por contas de teste (senha = ESPELHO_SYNC_TEST_PASSWORD).
 *  - Neutraliza na cópia: outbox, sessão do WhatsApp, lembretes, follow-ups, recuperação da Amanda.
 */
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import os from 'os';
import { anonimizar, COLECOES_EQUIPE } from '../../scripts/espelho/anonimizar.mjs';

const TAG = '[EspelhoSync]';
const SKIP = new Set(['outboxes', 'whatsappwebstates', 'baileyssessions']);
const PREFIXO = '__novo__';
const CONTROLE = '_espelho_controle';
const EXECUCOES = '_espelho_execucoes';
const BATCH = 1000;
const LOCK_MS = 2 * 60 * 60 * 1000;
const M0_MB = 512;
// vínculos conferidos (coleção, campo, coleção alvo)
const VINCULOS = [
  ['appointments', 'patient', 'patients'], ['appointments', 'doctor', 'doctors'],
  ['appointments', 'package', 'packages'], ['appointments', 'session', 'sessions'],
  ['payments', 'patient', 'patients'], ['payments', 'appointment', 'appointments'],
  ['packages', 'patient', 'patients'], ['packages', 'doctor', 'doctors'],
  ['sessions', 'patient', 'patients'], ['sessions', 'doctor', 'doctors'],
];
const CONTAS_TESTE = [['admins', 'admin@espelho.local'], ['doctors', 'terapeuta@espelho.local'], ['users', 'secretaria@espelho.local', { role: 'secretary' }]];

const mb = (b) => Math.round((b / 1048576) * 10) / 10;
const hostOf = (uri) => { try { return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname.toLowerCase(); } catch { return ''; } };

export function validarConfig(env = process.env) {
  const src = env.PROD_URI_READONLY, dst = env.ESPELHO_SYNC_TARGET_URI;
  const dbName = env.ESPELHO_SYNC_TARGET_DB || 'fono_dev_espelho';
  if (!src) throw new Error('PROD_URI_READONLY ausente');
  if (!dst) throw new Error('ESPELHO_SYNC_TARGET_URI ausente');
  if (/prod/i.test(dbName)) throw new Error(`banco de destino "${dbName}" parece produção`);
  const proibidos = [src, env.MONGO_URI, env.MONGODB_URI].filter(Boolean).map(hostOf);
  if (proibidos.includes(hostOf(dst))) throw new Error('destino está no mesmo cluster da produção');
  if (!env.ESPELHO_SYNC_TEST_PASSWORD || env.ESPELHO_SYNC_TEST_PASSWORD.length < 8) throw new Error('ESPELHO_SYNC_TEST_PASSWORD ausente (mín. 8 caracteres)');
  return { src, dst, dbName, senhaTeste: env.ESPELHO_SYNC_TEST_PASSWORD, limiteMb: Number(env.ESPELHO_SYNC_LIMITE_MB || M0_MB), pausadoEnv: env.ESPELHO_SYNC_PAUSED === 'true' };
}

async function conectar(cfg) {
  const src = new MongoClient(cfg.src, { maxPoolSize: 2, readPreference: 'secondaryPreferred' });
  const dst = new MongoClient(cfg.dst, { maxPoolSize: 2 });
  await src.connect(); await dst.connect();
  return { src, dst, S: src.db(), T: dst.db(cfg.dbName) };
}
const fechar = async (c) => { await c?.src?.close().catch(() => {}); await c?.dst?.close().catch(() => {}); };

/** Mede a produção (só leitura) e o espaço no destino. Não escreve nada. */
export async function medir(S, T, cfg) {
  const colecoes = [];
  for (const { name } of await S.listCollections({ type: 'collection' }).toArray()) {
    if (name.startsWith('system.') || SKIP.has(name)) continue;
    const st = await S.command({ collStats: name }).catch(() => ({}));
    colecoes.push({ nome: name, documentos: st.count ?? await S.collection(name).estimatedDocumentCount(), dadosMb: mb(st.size || 0), indicesMb: mb(st.totalIndexSize || 0), indices: st.nindexes ?? 0 });
  }
  const prod = { colecoes: colecoes.length, documentos: colecoes.reduce((a, c) => a + c.documentos, 0), dadosMb: mb(colecoes.reduce((a, c) => a + c.dadosMb * 1048576, 0)), indicesMb: mb(colecoes.reduce((a, c) => a + c.indicesMb * 1048576, 0)), indices: colecoes.reduce((a, c) => a + c.indices, 0) };
  let destinoAtualMb = 0, outrosBancosMb = null;
  if (T) {
    const ts = await T.stats().catch(() => null);
    if (ts) destinoAtualMb = mb((ts.dataSize || 0) + (ts.indexSize || 0));
    const dbs = await T.client.db('admin').command({ listDatabases: 1 }).catch(() => null);
    if (dbs) outrosBancosMb = mb(dbs.databases.filter((d) => !['admin', 'local', 'config', cfg.dbName].includes(d.name)).reduce((a, d) => a + (d.sizeOnDisk || 0), 0));
  }
  const novaCopiaMb = Math.round((prod.dadosMb + prod.indicesMb) * 10) / 10;
  // durante a cópia coexistem: cópia atual + "__novo__*" + outros bancos do cluster
  const picoMb = Math.round((novaCopiaMb + destinoAtualMb + (outrosBancosMb || 0)) * 10) / 10;
  return { prod, colecoes, destinoAtualMb, outrosBancosMb, novaCopiaMb, picoMb, limiteMb: cfg.limiteMb, cabe: picoMb <= cfg.limiteMb * 0.9 && prod.colecoes * 2 < 500 };
}

async function pegarTrava(T, dono) {
  const agora = new Date();
  try {
    const r = await T.collection(CONTROLE).findOneAndUpdate(
      { _id: 'trava', $or: [{ ate: { $lt: agora } }, { ate: { $exists: false } }] },
      { $set: { ate: new Date(Date.now() + LOCK_MS), dono, desde: agora } },
      { upsert: true, returnDocument: 'after' });
    return (r?.value ?? r)?.dono === dono;
  } catch (e) { if (e.code === 11000) return false; throw e; }
}
const soltarTrava = (T, dono) => T.collection(CONTROLE).deleteOne({ _id: 'trava', dono }).catch(() => {});

async function contarOrfaos(db, prefixo = '') {
  const out = {};
  const nomes = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const [c, campo, alvo] of VINCULOS) {
    if (!nomes.has(prefixo + c) || !nomes.has(prefixo + alvo)) continue;
    const [r] = await db.collection(prefixo + c).aggregate([
      { $match: { [campo]: { $type: 'objectId' } } },
      { $lookup: { from: prefixo + alvo, localField: campo, foreignField: '_id', as: 'x', pipeline: [{ $project: { _id: 1 } }] } },
      { $group: { _id: null, total: { $sum: 1 }, orfaos: { $sum: { $cond: [{ $eq: [{ $size: '$x' }, 0] }, 1, 0] } } } },
    ], { allowDiskUse: true }).toArray();
    out[`${c}.${campo}→${alvo}`] = { comVinculo: r?.total || 0, orfaos: r?.orfaos || 0 };
  }
  return out;
}

async function trocar(T, nome) {
  try {
    await T.collection(PREFIXO + nome).rename(nome, { dropTarget: true });
  } catch (e) {
    // fallback (cluster sem renameCollection): substitui via $out
    await T.collection(nome).drop().catch(() => {});
    await T.collection(PREFIXO + nome).aggregate([{ $out: nome }]).toArray();
    const idx = await T.collection(PREFIXO + nome).listIndexes().toArray();
    const extra = idx.filter((x) => x.name !== '_id_').map(({ v, ns, ...rest }) => rest);
    if (extra.length) await T.collection(nome).createIndexes(extra).catch(() => {});
    await T.collection(PREFIXO + nome).drop().catch(() => {});
  }
}

/**
 * Executa a cópia. opts.medirSomente → só mede (nada é escrito, nem no destino).
 * Retorna o relatório e grava em _espelho_execucoes (no destino).
 */
export async function runEspelhoSync(opts = {}) {
  const cfg = validarConfig();
  const dono = `${os.hostname()}:${process.pid}:${Date.now()}`;
  const t0 = Date.now();
  const rel = { inicio: new Date(), dono, origem: 'produção (somente leitura)', destino: cfg.dbName, status: 'iniciado' };
  let c, travado = false;
  try {
    c = await conectar(cfg);
    const { S, T } = c;
    rel.medicao = await medir(S, T, cfg);
    if (opts.medirSomente) { rel.status = 'medido'; return rel; }

    const ctl = await T.collection(CONTROLE).findOne({ _id: 'controle' });
    if (cfg.pausadoEnv || ctl?.pausado) { rel.status = 'pausado'; console.log(`${TAG} ⏸️ pausado (${cfg.pausadoEnv ? 'ESPELHO_SYNC_PAUSED' : ctl.motivo || 'controle'}), nada feito`); return rel; }
    if (!rel.medicao.cabe && !opts.ignorarLimite) throw new Error(`não cabe: pico estimado ${rel.medicao.picoMb} MB (limite seguro ${Math.round(cfg.limiteMb * 0.9)} MB)`);
    travado = await pegarTrava(T, dono);
    if (!travado) { rel.status = 'ignorado_em_andamento'; console.log(`${TAG} outra execução em andamento, pulando`); return rel; }

    // limpa sobras de execução anterior que falhou antes da troca
    for (const { name } of await T.listCollections().toArray()) if (name.startsWith(PREFIXO)) await T.collection(name).drop().catch(() => {});

    const hashTeste = await bcrypt.hash(cfg.senhaTeste, 10);
    const usadas = new Set();
    const contagens = {};
    const avisosIndice = [];
    const fonte = (await S.listCollections({ type: 'collection' }).toArray()).map((x) => x.name).filter((n) => !n.startsWith('system.') && !SKIP.has(n));
    for (const name of fonte) {
      const antes = await S.collection(name).estimatedDocumentCount();
      let buf = [], n = 0;
      const flush = async () => { if (buf.length) { await T.collection(PREFIXO + name).insertMany(buf, { ordered: false }); n += buf.length; buf = []; } };
      for await (const doc of S.collection(name).find({})) {
        const d = anonimizar(name, doc, { equipe: true, credenciais: true });
        if (COLECOES_EQUIPE.has(name)) {
          const teste = CONTAS_TESTE.find(([col, email, filtro]) => col === name && !usadas.has(email) && (!filtro || Object.entries(filtro).every(([k, v]) => d[k] === v)) && d.active !== false && d.isActive !== false);
          if (teste) usadas.add(teste[1]);
          d.email = teste ? teste[1] : `${name}.${String(d._id).slice(-8)}@espelho.local`;
          if ('password' in d || teste) d.password = hashTeste;
        }
        buf.push(d);
        if (buf.length === BATCH) await flush();
      }
      await flush();
      if (!n) await T.createCollection(PREFIXO + name).catch(() => {});
      const idx = (await S.collection(name).listIndexes().toArray()).filter((x) => x.name !== '_id_').map(({ v, ns, ...rest }) => rest);
      for (const i of idx) await T.collection(PREFIXO + name).createIndexes([i]).catch((e) => avisosIndice.push(`${name}.${i.name}: ${e.message.slice(0, 120)}`));
      contagens[name] = { producao: antes, copiados: n, indices: idx.length + 1 };
    }

    // neutraliza disparos na cópia (antes da troca, para nunca existir janela com pendências reais)
    const upd = async (col, f, s) => (await T.listCollections({ name: PREFIXO + col }).hasNext()) ? (await T.collection(PREFIXO + col).updateMany(f, { $set: s })).modifiedCount : 0;
    rel.neutralizados = {
      reminders: await upd('reminders', { status: 'pending' }, { status: 'canceled', espelho: true }),
      followups: await upd('followups', { status: 'scheduled' }, { status: 'canceled', espelho: true }),
      leadsRecovery: await upd('leads', { 'recovery.nextAttemptAt': { $ne: null } }, { 'recovery.nextAttemptAt': null }),
    };

    // validação antes de trocar
    rel.vinculos = { producao: await contarOrfaos(S), copia: await contarOrfaos(T, PREFIXO) };
    const divergentes = Object.keys(rel.vinculos.copia).filter((k) => rel.vinculos.copia[k].orfaos > (rel.vinculos.producao[k]?.orfaos ?? 0) + Math.ceil((rel.vinculos.producao[k]?.comVinculo || 0) * 0.001));
    const faltando = Object.entries(contagens).filter(([, v]) => v.copiados < v.producao * 0.99 - 5).map(([k]) => k);
    if (divergentes.length || faltando.length) throw new Error(`validação falhou — vínculos: [${divergentes}] contagens: [${faltando}]`);
    rel.contasTeste = [...usadas];

    // troca
    await T.collection(CONTROLE).updateOne({ _id: 'controle' }, { $set: { estado: 'trocando', trocaInicio: new Date() } }, { upsert: true });
    for (const name of fonte) await trocar(T, name);
    for (const { name } of await T.listCollections().toArray()) if (!name.startsWith('_espelho') && !name.startsWith('system.') && !fonte.includes(name) && !name.startsWith(PREFIXO)) await T.collection(name).drop().catch(() => {});

    rel.contagens = contagens;
    rel.avisosIndice = avisosIndice;
    rel.status = 'ok';
  } catch (err) {
    rel.status = rel.status === 'iniciado' ? 'falhou' : rel.status;
    rel.erro = err.message;
    console.error(`${TAG} ❌ ${err.message}`);
  } finally {
    rel.fim = new Date();
    rel.duracaoSeg = Math.round((Date.now() - t0) / 1000);
    if (c?.T && !opts.medirSomente) {
      const T = c.T;
      await T.collection(EXECUCOES).insertOne({ ...rel, medicao: { ...rel.medicao, colecoes: undefined } }).catch(() => {});
      const set = { ultimaExecucao: rel.fim, ultimoStatus: rel.status };
      if (rel.status === 'ok') Object.assign(set, { ultimaOk: rel.fim, estado: 'consistente', ultimoErro: null });
      if (rel.status === 'falhou') Object.assign(set, { ultimaFalha: rel.fim, ultimoErro: rel.erro });
      await T.collection(CONTROLE).updateOne({ _id: 'controle' }, { $set: set, ...(rel.status === 'falhou' ? {} : {}) }, { upsert: true }).catch(() => {});
      // se falhou no meio da troca, marca inconsistente
      const ctl = await T.collection(CONTROLE).findOne({ _id: 'controle' }).catch(() => null);
      if (rel.status === 'falhou' && ctl?.estado === 'trocando') await T.collection(CONTROLE).updateOne({ _id: 'controle' }, { $set: { estado: 'inconsistente' } }).catch(() => {});
      if (travado) await soltarTrava(T, dono);
    }
    await fechar(c);
    console.log(`${TAG} ${rel.status} em ${rel.duracaoSeg}s`);
  }
  return rel;
}

export async function definirPausa(pausado, motivo = '') {
  const cfg = validarConfig();
  const c = await conectar(cfg);
  try {
    await c.T.collection(CONTROLE).updateOne({ _id: 'controle' }, { $set: { pausado, motivo, pausaAtualizadaEm: new Date() } }, { upsert: true });
    return await c.T.collection(CONTROLE).findOne({ _id: "controle" });
  } finally { await fechar(c); }
}

export async function status() {
  const cfg = validarConfig();
  const c = await conectar(cfg);
  try {
    return { controle: await c.T.collection(CONTROLE).findOne({ _id: 'controle' }), ultimas: await c.T.collection(EXECUCOES).find({}, { projection: { contagens: 0, vinculos: 0 } }).sort({ inicio: -1 }).limit(10).toArray() };
  } finally { await fechar(c); }
}

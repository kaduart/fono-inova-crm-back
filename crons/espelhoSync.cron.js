// crons/espelhoSync.cron.js
/**
 * 🪞 Cópia diária PRODUÇÃO → banco DEV na nuvem (Atlas free separado), às 18:50 BRT.
 *
 * DESLIGADO por padrão. Liga/desliga pelo painel do Render (mesmo modelo do ENABLE_WORKERS):
 *   ESPELHO_SYNC_ENABLED=true            → liga
 *   ESPELHO_SYNC_TARGET_URI=mongodb+srv://...  (cluster DEV, NUNCA o de produção)
 *   ESPELHO_SYNC_TARGET_DB=fono_dev_espelho    (opcional)
 *   ESPELHO_SYNC_CRU=true                → copia sem anonimizar (padrão: anonimiza)
 *   ESPELHO_SYNC_MAX_MB=450              → aborta se a produção passar disso (M0 = 512 MB)
 *   ESPELHO_SYNC_HORARIO="50 18 * * *"   → opcional
 *
 * Segurança: produção é lida SÓ com PROD_URI_READONLY. Recusa destino no mesmo host do
 * MONGO_URI/PROD_URI_READONLY ou com nome de banco de produção. Desliga na cópia outbox,
 * sessão do WhatsApp, lembretes, follow-ups e recuperação da Amanda.
 * Lock Redis evita rodar duas vezes (server.js e cron-worker chamam startAllCrons).
 */
import cron from 'node-cron';
import { MongoClient } from 'mongodb';
import { acquireLock, releaseLock } from '../utils/redisLock.js';
import { anonimizar } from '../scripts/espelho/anonimizar.mjs';

const TAG = '[EspelhoSync]';
const SKIP = new Set(['outboxes', 'whatsappwebstates', 'baileyssessions']);
const BATCH = 1000;

const hostOf = (uri) => { try { return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname.toLowerCase(); } catch { return ''; } };

export function validarConfig(env = process.env) {
    const src = env.PROD_URI_READONLY, dst = env.ESPELHO_SYNC_TARGET_URI;
    const dbName = env.ESPELHO_SYNC_TARGET_DB || 'fono_dev_espelho';
    if (!src) throw new Error('PROD_URI_READONLY ausente');
    if (!dst) throw new Error('ESPELHO_SYNC_TARGET_URI ausente');
    if (/prod/i.test(dbName)) throw new Error(`banco de destino "${dbName}" parece produção`);
    const proibidos = [src, env.MONGO_URI, env.MONGODB_URI].filter(Boolean).map(hostOf);
    if (proibidos.includes(hostOf(dst))) throw new Error('destino está no mesmo cluster da produção');
    return { src, dst, dbName, anon: env.ESPELHO_SYNC_CRU !== 'true', maxMb: Number(env.ESPELHO_SYNC_MAX_MB || 450) };
}

export async function runEspelhoSync() {
    const cfg = validarConfig();
    const lockKey = 'cron:espelhoSync';
    const token = await acquireLock(lockKey, 3600);
    if (!token) { console.log(`${TAG} já rodando em outro processo, pulando`); return { status: 'locked' }; }
    const src = new MongoClient(cfg.src, { maxPoolSize: 2, readPreference: 'secondaryPreferred' });
    const dst = new MongoClient(cfg.dst, { maxPoolSize: 2 });
    const t0 = Date.now();
    try {
        await src.connect(); await dst.connect();
        const S = src.db(), T = dst.db(cfg.dbName);
        const { dataSize } = await S.stats();
        const mb = Math.round(dataSize / 1048576);
        if (mb > cfg.maxMb) throw new Error(`produção tem ${mb} MB, acima do limite ${cfg.maxMb} MB do destino`);
        console.log(`${TAG} ${S.databaseName} (${mb} MB, só leitura) → ${cfg.dbName}${cfg.anon ? ' [anonimizado]' : ' [CRU]'}`);
        await T.dropDatabase();
        let total = 0;
        for (const { name } of await S.listCollections({ type: 'collection' }).toArray()) {
            if (name.startsWith('system.') || SKIP.has(name)) continue;
            let buf = [], n = 0;
            const flush = async () => { if (buf.length) { await T.collection(name).insertMany(buf, { ordered: false }); n += buf.length; buf = []; } };
            for await (const doc of S.collection(name).find({})) {
                buf.push(cfg.anon ? anonimizar(name, doc) : doc);
                if (buf.length === BATCH) await flush();
            }
            await flush();
            if (!n) await T.createCollection(name).catch(() => {});
            const idx = (await S.collection(name).listIndexes().toArray()).filter((x) => x.name !== '_id_').map(({ v, ns, ...rest }) => rest);
            if (idx.length) await T.collection(name).createIndexes(idx).catch(() => {});
            total += n;
        }
        await T.collection('reminders').updateMany({ status: 'pending' }, { $set: { status: 'canceled', espelho: true } });
        await T.collection('followups').updateMany({ status: 'scheduled' }, { $set: { status: 'canceled', espelho: true } });
        await T.collection('leads').updateMany({ 'recovery.nextAttemptAt': { $ne: null } }, { $set: { 'recovery.nextAttemptAt': null } });
        const s = Math.round((Date.now() - t0) / 1000);
        console.log(`${TAG} ✅ ${total} documentos copiados em ${s}s`);
        return { status: 'ok', total, seconds: s };
    } catch (err) {
        console.error(`${TAG} ❌ ${err.message}`);
        return { status: 'error', error: err.message };
    } finally {
        await src.close().catch(() => {}); await dst.close().catch(() => {});
        await releaseLock(lockKey, token).catch(() => {});
    }
}

export function scheduleEspelhoSync() {
    try { validarConfig(); } catch (err) { console.error(`${TAG} ❌ não agendado: ${err.message}`); return null; }
    const horario = process.env.ESPELHO_SYNC_HORARIO || '50 18 * * *';
    console.log(`${TAG} agendado (${horario} America/Sao_Paulo)`);
    return cron.schedule(horario, () => { runEspelhoSync().catch((e) => console.error(`${TAG} ❌ ${e.message}`)); }, { timezone: 'America/Sao_Paulo' });
}

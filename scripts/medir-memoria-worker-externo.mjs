// Medição do processo pai do crm-worker em modo externo (18/11/2026): imports reais + carga sintética pela
// ponte (1000 envios ao conector simulado em outro processo e 5000 eventos recebidos). Sem Mongo/Redis reais.
// Uso (variáveis falsas só para os imports): WHATSAPP_CONNECTOR_MODE=external node --expose-gc scripts/medir-memoria-worker-externo.mjs
// Mede o processo PAI do crm-worker em modo externo: imports reais + carga sintética pela ponte.
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
const mb = (n) => Math.round(n / 1048576);
const rss = () => { global.gc?.(); return mb(process.memoryUsage().rss); };
const out = { vazio: rss() };
const root = process.cwd();
for (const m of ['models/index.js', 'workers/index.js', 'config/cronManager.js', 'jobs/gmbScheduledTasks.js', 'crons/gmbAutoRepublish.js', 'workers/postGenerationWorker.js']) await import(path.join(root, m));
out.paiImports = rss();
const { makeConnectorSender, makeStatusPoller } = await import(path.join(root, 'workers/whatsappConnectorBridge.js'));
const { createConnectorClient } = await import(path.join(root, 'services/whatsappConnector/client.js'));
const { receiveConnectorEvents } = await import(path.join(root, 'services/whatsappConnector/eventsReceiver.js'));
const { buildEvent, signRequest, SIGNATURE_HEADER } = await import(path.join(root, 'services/whatsappConnector/contract.js'));
out.paiMaisPonte = rss();

// conector simulado em OUTRO processo (não entra na conta deste)
const SECRET = 'm'.repeat(40);
const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const conn = spawn(process.execPath, ['src/index.js'], { cwd: path.join(root, 'whatsapp-connector'), env: { PATH: process.env.PATH, WA_CONNECTOR_ENGINE: 'simulator', WA_CONNECTOR_SECRET: SECRET, CRM_EVENTS_URL: 'https://x/y', WA_CONNECTOR_DATA_DIR: `/tmp/claude-0/measure/conn-${Date.now()}`, PORT: String(port), WA_CONNECTOR_SEND_MIN_INTERVAL_MS: '0' } });
await new Promise((r) => conn.stdout.on('data', (d) => { if (String(d).includes('🟢')) r(); }));
const client = createConnectorClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
const mem = new Map();
const DeliveryOutcome = { SENT: 'sent', ALREADY_SENT: 'already_sent', IN_PROGRESS: 'in_progress', UNCERTAIN: 'uncertain' };
const guardedSend = async ({ deliveryKey, send }) => { if (mem.has(deliveryKey)) return { outcome: 'already_sent' }; const r = await send(); mem.set(deliveryKey, r.messageId); return { outcome: 'sent', result: r, providerMessageId: r.messageId }; };
const sender = makeConnectorSender({ client, guardedSend, DeliveryOutcome });
const poll = makeStatusPoller({ client, writeState: async () => {}, logger: { log() {}, warn() {}, error() {} } });
let peak = 0; const sample = () => { const v = mb(process.memoryUsage().rss); if (v > peak) peak = v; };
const t0 = Date.now();
const N = Number(process.env.N_SENDS || 1000);
for (let i = 0; i < N; i++) { await sender({ id: `m${i}` }, '5562999990000', `mensagem ${i} ` + 'x'.repeat(300), i % 5 === 0 ? { attendanceConfirmation: true, appointmentId: `a${i}` } : {}); if (i % 50 === 0) { await poll(); sample(); } }
const tSends = Date.now() - t0;
const jobs = new Map();
const enqueue = async (jobId, ev) => { if (jobs.has(jobId)) return false; jobs.set(jobId, ev); return true; };
const E = Number(process.env.N_EVENTS || 5000);
for (let i = 0; i < E; i += 50) {
  const batch = Array.from({ length: 50 }, (_, k) => buildEvent('message.inbound', { waMessageId: `w${i + k}`, chatId: '5562999990000@c.us', phone: '5562999990000', body: 'olá '.repeat(40), timestamp: 1, source: 'live', ctwa: { sourceId: '1', conversionData: 'A'.repeat(200) } }, { connectorId: 'm' }));
  const raw = Buffer.from(JSON.stringify({ events: batch }));
  const headers = { [SIGNATURE_HEADER]: signRequest(SECRET, { method: 'POST', path: '/api/whatsapp-connector/events', body: raw }) };
  await receiveConnectorEvents({ rawBody: raw, headers, method: 'POST', path: '/api/whatsapp-connector/events', secret: SECRET, enqueue });
  sample();
}
out.carga = { envios: N, eventos: E, jobsUnicos: jobs.size, msEnvios: tSends, picoRssMB: peak, rssDepoisGcMB: rss() };
conn.kill('SIGTERM');
console.log(JSON.stringify(out));
process.exit(0);

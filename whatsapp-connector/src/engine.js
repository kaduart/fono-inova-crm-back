// whatsapp-connector/src/engine.js
//
// Motor whatsapp-web.js do conector (18/11/2026). Independente do CRM: não importa nada do repositório do
// CRM, não fala com MongoDB nem Redis. Mantém a sessão (LocalAuth em disco) e o Chrome, e transforma o que
// acontece no WhatsApp em eventos simples (message.inbound / message.outbound / poll.vote) para o CRM.
//
// Portado do services/whatsappWebJsService.js do CRM, mantendo as correções de produção:
//   - ready que não dispara (sessão já sincronizada): polling de getState() e handler da lib (09/11);
//   - frame "detached" depois do init: aba nova no mesmo perfil e reinjeção (09/11);
//   - Chrome que morre sem a lib perceber: escuta o processo e reinicia (09/11);
//   - teto de heap JS na aba (18/11), flags sem isolamento por site, Chrome fixado por versão.
// Diferenças de propósito:
//   - reinício é DENTRO do processo (destrói o client e cria outro, com espera crescente), não process.exit;
//   - takeoverOnConflict=false por padrão: se a mesma sessão abrir em outro lugar, este lado PARA e mostra
//     status 'conflict' em vez de disputar (WA_TAKEOVER_ON_CONFLICT=true volta ao comportamento antigo);
//   - textos de negócio (enquete, padrões da varredura) e normalização de telefone vêm do CRM.
//
// Dependências injetáveis (testes usam um whatsapp-web.js falso): lib = { Client, LocalAuth, Poll },
// toQrDataUrl(qr) → data URL.

const isContactChatId = (id) => Boolean(id) && !id.endsWith('@g.us') && !id.endsWith('@newsletter') && id !== 'status@broadcast';
const isRealBRPhone = (p) => /^55\d{10,11}$/.test(String(p || '').replace(/\D/g, ''));
const CTWA_HEAVY_KEYS = new Set(['thumbnail', 'thumbnailUrl', 'originalImageUrl', 'mediaUrl']);
const stripHeavy = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !CTWA_HEAVY_KEYS.has(k))) : null);

/** Erro do envio que PROVA que nada saiu (código no contrato: NOT_CONNECTED / INVALID_NUMBER / NO_WHATSAPP). */
export const notSent = (code, message) => Object.assign(new Error(message), { code, deliveryNotSent: true });

export function chromeArgs({ jsHeapMb = 1024 } = {}) {
  const heap = Number(jsHeapMb);
  return [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
    '--no-first-run', '--no-zygote', '--disable-gpu', '--disable-software-rasterizer',
    '--disable-blink-features=AutomationControlled', '--window-size=1920,1080', '--mute-audio', '--log-level=3',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-sync', '--disable-extensions',
    '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process',
    ...(Number.isFinite(heap) && heap > 0 ? [`--js-flags=--max-old-space-size=${Math.round(heap)}`] : []),
  ];
}

/**
 * @param {{ lib: { Client: any, LocalAuth: any, Poll?: any }, toQrDataUrl?: (qr:string)=>Promise<string>,
 *   authPath: string, executablePath?: string|null, jsHeapMb?: number, initTimeoutMs?: number,
 *   readyTimeoutMs?: number, takeoverOnConflict?: boolean, catchUpHours?: number, catchUpDelayMs?: number,
 *   restartBackoffMs?: number[], maxRestartsPerWindow?: number, restartWindowMs?: number,
 *   logger?: Console, now?: ()=>number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} o
 */
export function createWhatsAppEngine({
  lib, toQrDataUrl = async () => null, authPath, executablePath = null, jsHeapMb = 1024,
  initTimeoutMs = 4 * 60_000, readyTimeoutMs = 10 * 60_000, takeoverOnConflict = false,
  catchUpHours = 72, catchUpDelayMs = 60_000,
  restartBackoffMs = [10_000, 30_000, 60_000, 120_000, 300_000], maxRestartsPerWindow = 8, restartWindowMs = 30 * 60_000,
  logger = console, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (!lib?.Client || !lib?.LocalAuth) throw new Error('engine: lib whatsapp-web.js obrigatória');
  if (!authPath) throw new Error('engine: authPath obrigatório');

  const state = {
    status: 'stopped', ready: false, authenticated: false, qrCode: null, lastDisconnectReason: null,
    lastAuthenticatedAt: null, qrCount: 0, initAttempts: 0, restarts: 0, updatedAt: null,
  };
  let client = null;
  let sink = null;
  let stopped = true;
  let initializing = null; // client cujo initialize() está em andamento
  const timers = new Set();
  const restartTimes = [];
  let restartTimer = null;
  let browserPid = null;

  const set = (patch) => { Object.assign(state, patch, { updatedAt: new Date(now()).toISOString() }); };
  const timer = (fn, ms) => { const t = setTimer(() => { timers.delete(t); fn(); }, ms); t?.unref?.(); timers.add(t); return t; };
  const clearAllTimers = () => { for (const t of timers) clearTimer(t); timers.clear(); };
  const emit = async (type, data) => {
    if (!data || !sink) return;
    try { await sink(type, data); } catch (err) { logger.warn?.(`[Engine] evento ${type} não enfileirado:`, err?.message); }
  };

  // ── Reinício (dentro do processo, com espera crescente e teto por janela) ──────────────────────────
  async function destroyClient() {
    const c = client;
    client = null;
    initializing = null; // initialize() pendurado do client velho não pode travar o próximo init
    browserPid = null;
    clearAllTimers();
    if (c) { try { await c.destroy(); } catch { /* já morto */ } }
  }

  async function restart(reason) {
    if (stopped) return;
    logger.error?.(`[Engine] ♻️ reinício: ${reason}`);
    const t = now();
    while (restartTimes.length && t - restartTimes[0] > restartWindowMs) restartTimes.shift();
    restartTimes.push(t);
    set({ ready: false, status: 'restarting', lastDisconnectReason: reason, restarts: state.restarts + 1 });
    await destroyClient();
    if (restartTimes.length > maxRestartsPerWindow) {
      // Falha repetida: para e deixa visível. Volta só com POST /v1/session/reconnect (botão no ERP).
      set({ status: 'failed', lastDisconnectReason: `${restartTimes.length} reinícios em ${Math.round(restartWindowMs / 60000)} min; último: ${reason}` });
      logger.error?.('[Engine] 🛑 reinícios demais — parado até reconexão manual');
      return;
    }
    const wait = restartBackoffMs[Math.min(restartTimes.length - 1, restartBackoffMs.length - 1)];
    if (restartTimer) clearTimer(restartTimer);
    restartTimer = setTimer(() => { restartTimer = null; init().catch(() => {}); }, wait);
    restartTimer?.unref?.();
  }

  // ── Telefone real de @lid (precisa do navegador) ───────────────────────────────────────────────────
  async function resolveLidPhone(c, lid) {
    const candidates = [];
    try {
      if (c?.getContactLidAndPhone) {
        const r = await c.getContactLidAndPhone([lid]);
        if (r?.[0]?.pn) candidates.push(String(r[0].pn).replace(/@.*$/, ''));
      }
    } catch { /* segue */ }
    try {
      const p = await c?.pupPage?.evaluate((id) => {
        const cols = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
        return cols.Contact?.get?.(id)?.phoneNumber?.user || null;
      }, lid);
      if (p) candidates.push(String(p));
    } catch { /* segue */ }
    return candidates.find(isRealBRPhone) || null;
  }

  async function readCtwaBytesInPage(c, msgId) {
    try {
      if (!c?.pupPage || !msgId) return {};
      const out = await c.pupPage.evaluate((id) => {
        const S = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
        const ctx = S.Msg?.get?.(id)?.ctwaContext;
        if (!ctx) return null;
        const toB64 = (v) => {
          if (v == null || typeof v === 'string') return null;
          let u8 = null;
          if (v instanceof Uint8Array) u8 = v;
          else if (v instanceof ArrayBuffer) u8 = new Uint8Array(v);
          else if (ArrayBuffer.isView(v)) u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          if (!u8 || !u8.length) return null;
          let bin = '';
          for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
          return btoa(bin);
        };
        return { conversionData: toB64(ctx.conversionData), ctwaSignals: toB64(ctx.ctwaSignals) };
      }, msgId);
      const res = {};
      if (out?.conversionData) res.conversionData = out.conversionData;
      if (out?.ctwaSignals) res.ctwaSignals = out.ctwaSignals;
      return res;
    } catch { return {}; }
  }

  /** msg do whatsapp-web.js → dados do evento message.inbound (null = não é conversa de contato). */
  async function normalizeInbound(msg, source = 'live') {
    if (!msg || msg.fromMe || msg.isStatus) return null;
    const from = msg.from || '';
    if (!isContactChatId(from)) return null;
    const ctwaRaw = msg._data?.ctwaContext || null;
    const ctwa = ctwaRaw ? { ...ctwaRaw, ...(await readCtwaBytesInPage(msg.client || client, msg.id?._serialized)) } : null;
    const ext = msg._data?.contextInfo?.externalAdReply || msg._data?.externalAdReply || null;
    if (ctwaRaw) logger.log?.('[Engine] 📣 ctwaContext recebido — chaves:', Object.keys(ctwaRaw).join(','));
    let phone = from.endsWith('@c.us') ? from.replace('@c.us', '') : null;
    if (!phone) phone = await resolveLidPhone(msg.client || client, from);
    return {
      waMessageId: msg.id?._serialized || null,
      chatId: from,
      phone: phone || null,
      body: String(msg.body || '').slice(0, 4096),
      type: msg.type || null,
      clinicPhone: ownPhoneOf(msg.to),
      timestamp: Number(msg.timestamp) || null,
      notifyName: msg._data?.notifyName || null,
      selectedButtonId: msg.selectedButtonId || msg._data?.selectedButtonId || null,
      ctwa: stripHeavy(ctwa),
      externalAdReply: stripHeavy(ext),
      source,
    };
  }

  // Número da própria clínica a partir do id do chat (só @c.us; @lid não traz telefone).
  const ownPhoneOf = (id) => (typeof id === 'string' && id.endsWith('@c.us') ? id.replace('@c.us', '') : null);

  async function normalizeOutbound(msg) {
    if (!msg || !msg.fromMe || msg.isStatus) return null;
    const to = msg.to || '';
    if (!isContactChatId(to)) return null;
    let phone = to.endsWith('@c.us') ? to.replace('@c.us', '') : null;
    if (!phone && to.endsWith('@lid')) phone = await resolveLidPhone(msg.client || client, to);
    if (!phone) return null;
    return { waMessageId: msg.id?._serialized || null, chatId: to, phone, timestamp: Number(msg.timestamp) || null, body: String(msg.body || '').slice(0, 4096), type: msg.type || null, clinicPhone: ownPhoneOf(msg.from) };
  }

  async function voterPhone(vote) {
    const voter = String(vote?.voter?._serialized || vote?.voter || '');
    if (voter.endsWith('@c.us')) return voter.replace('@c.us', '');
    if (!voter.endsWith('@lid')) return null;
    return resolveLidPhone(client, voter);
  }

  async function normalizeVote(vote, fallbackPollId = null) {
    const optionName = vote?.selectedOptions?.[0]?.name || '';
    if (!optionName) return null;
    return {
      voterPhone: (await voterPhone(vote)) || null,
      pollMessageId: vote?.parentMsgKey?._serialized || vote?.parentMessage?.id?._serialized || fallbackPollId,
      optionName,
      respondedAtMs: vote?.interractedAtTs ? Number(vote.interractedAtTs) : null,
    };
  }

  // ── Recuperação de origem do período em que o conector ficou fora (só leitura) ─────────────────────
  async function catchUp(c) {
    if (client !== c || !state.ready) return;
    const sinceSec = Math.floor(now() / 1000) - catchUpHours * 3600;
    let checked = 0;
    try {
      const chats = (await c.getChats()).filter((ch) => !ch.isGroup && (ch.timestamp || 0) >= sinceSec).slice(0, 150);
      for (const chat of chats) {
        if (client !== c) return;
        try {
          for (const m of await chat.fetchMessages({ limit: 8 })) {
            if ((m.timestamp || 0) < sinceSec) continue;
            // Resposta da clínica no período também volta (a tela Conversas não fica "sem resposta").
            if (m.fromMe) { await emit('message.outbound', await normalizeOutbound(m)); continue; }
            await emit('message.inbound', await normalizeInbound(m, 'catchup'));
            checked++;
          }
        } catch { /* conversa com erro de carga */ }
      }
      logger.log?.(`[Engine] 🔁 catch-up: ${chats.length} conversas, ${checked} mensagens (${catchUpHours}h)`);
    } catch (err) {
      logger.warn?.('[Engine] ⚠️ catch-up falhou (ignorado):', err?.message);
    }
  }

  // ── Correções de produção portadas ─────────────────────────────────────────────────────────────────
  function startReadyPoll(c) {
    const tick = async () => {
      if (client !== c || state.ready) return;
      try {
        if ((await c.getState()) === 'CONNECTED') { logger.log?.('[Engine] ✅ getState()=CONNECTED — forçando ready'); onReady(c); return; }
      } catch { /* ainda não */ }
      timer(tick, 10_000);
    };
    timer(tick, 10_000);
  }

  function startSyncedSessionKick(c) {
    let kicked = 0;
    let recoveries = 0;
    const tick = async () => {
      if (client !== c || state.ready || !c.pupPage) return;
      try {
        const sock = await c.pupPage.evaluate(() => {
          try { const S = window.require('WAWebSocketModel').Socket; return { hasSynced: !!S.hasSynced, handler: typeof window.onAppStateHasSyncedEvent }; } catch (e) { return { error: String(e?.message || e) }; }
        });
        if (state.status === 'initializing' && sock?.hasSynced && sock.handler === 'function' && kicked < 3) {
          kicked++;
          logger.log?.(`[Engine] 🩹 sessão sincronizada sem 'ready' — disparando handler da lib (${kicked})`);
          await c.pupPage.evaluate(() => window.onAppStateHasSyncedEvent());
        }
      } catch (e) {
        const m = e?.message || String(e);
        if (/detached|Target closed|Session closed/i.test(m) && recoveries < 2) { recoveries++; await recoverDetachedPage(c, recoveries); }
      }
      timer(tick, 15_000);
    };
    timer(tick, 5_000);
  }

  async function recoverDetachedPage(c, attempt) {
    const browser = c?.pupBrowser;
    if (!browser) return;
    try {
      logger.warn?.(`[Engine] 🛠️ frame destacado — aba nova no mesmo perfil (tentativa ${attempt})`);
      const old = c.pupPage;
      const page = await browser.newPage();
      if (c.options?.userAgent) await page.setUserAgent(c.options.userAgent);
      c.pupPage = page;
      if (old && old !== page) { try { await old.close(); } catch { /* morta */ } }
      await page.goto('https://web.whatsapp.com/', { waitUntil: 'load', timeout: 120_000, referer: 'https://whatsapp.com/' });
      await c.inject();
      page.on('framenavigated', () => { c.inject().catch(() => {}); });
    } catch (err) { logger.warn?.('[Engine] recuperação da aba falhou:', err?.message); }
  }

  function watchBrowser(c) {
    const browser = c?.pupBrowser;
    if (!browser || typeof browser.on !== 'function') return;
    const proc = typeof browser.process === 'function' ? browser.process() : null;
    browserPid = proc?.pid || null;
    proc?.once?.('exit', (code, signal) => logger.error?.(`[Engine] 💥 Chrome saiu: code=${code} signal=${signal} status=${state.status}`));
    browser.once('disconnected', () => { if (client === c) restart('conexão com o Chrome perdida'); });
    // Aba morta (ex.: teto de heap JS): reinicia só o Chrome.
    c.pupPage?.on?.('error', (err) => { if (client === c) restart(`aba do WhatsApp caiu (${err?.message || err})`); });
  }

  function onReady(c) {
    if (client !== c || state.ready) return;
    set({ ready: true, authenticated: true, status: 'ready', qrCode: null, qrCount: 0, initAttempts: 0 });
    restartTimes.length = 0;
    timer(() => catchUp(c), catchUpDelayMs);
  }

  // ── Ciclo de vida ──────────────────────────────────────────────────────────────────────────────────
  function createClient() {
    const puppeteer = { headless: 'new', dumpio: false, protocolTimeout: 120_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: chromeArgs({ jsHeapMb }) };
    if (executablePath) puppeteer.executablePath = executablePath;
    const c = new lib.Client({
      authStrategy: new lib.LocalAuth({ dataPath: authPath }),
      authTimeoutMs: 600_000,
      takeoverOnConflict,
      takeoverTimeoutMs: 30_000,
      restartOnAuthFail: false,
      qrMaxRetries: 0,
      puppeteer,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });

    c.on('qr', async (qr) => {
      if (client !== c) return;
      let qrCode = null;
      try { qrCode = await toQrDataUrl(qr); } catch (e) { logger.warn?.('[Engine] QR:', e?.message); }
      set({ status: 'qr', qrCode, qrCount: state.qrCount + 1 });
      logger.log?.(`[Engine] 📡 QR gerado (${state.qrCount})`);
    });
    c.on('loading_screen', (percent) => { if (client === c && !state.ready) set({ status: 'connecting' }); logger.log?.(`[Engine] ⏳ carregando ${percent}%`); });
    c.on('authenticated', () => {
      if (client !== c) return;
      set({ authenticated: true, status: 'connecting', lastAuthenticatedAt: new Date(now()).toISOString() });
      startReadyPoll(c);
      timer(() => { if (client === c && !state.ready) restart(`autenticado mas sem ready em ${Math.round(readyTimeoutMs / 60000)} min`); }, readyTimeoutMs);
    });
    c.on('ready', () => { logger.log?.('[Engine] ✅ ready'); onReady(c); });
    c.on('auth_failure', (m) => {
      if (client !== c) return;
      set({ ready: false, authenticated: false, status: 'auth_failure', lastDisconnectReason: `auth_failure: ${m}` });
      logger.error?.('[Engine] 🔴 auth_failure:', m);
    });
    c.on('change_state', (st) => {
      if (client !== c) return;
      if (st === 'CONFLICT' && !takeoverOnConflict) {
        // A mesma sessão abriu em outro lugar: não disputa. Fica parado e visível até alguém decidir.
        set({ ready: false, status: 'conflict', lastDisconnectReason: 'sessão aberta em outro lugar (CONFLICT); este conector parou para não disputar' });
        logger.error?.('[Engine] ⚔️ CONFLICT — parado sem retomar a sessão');
        destroyClient().catch(() => {});
        return;
      }
      if (st === 'UNPAIRED' || st === 'UNPAIRED_IDLE') set({ ready: false, authenticated: false, status: 'disconnected', lastDisconnectReason: st });
    });
    c.on('disconnected', (reason) => {
      if (client !== c) return;
      set({ ready: false, authenticated: false, status: 'disconnected', lastDisconnectReason: String(reason) });
      logger.warn?.(`[Engine] 🔴 desconectado: ${reason}`);
      if (state.status !== 'conflict') restart(`desconectado (${reason})`);
    });
    c.on('message', (msg) => { normalizeInbound(msg, 'live').then((d) => emit('message.inbound', d)).catch((e) => logger.warn?.('[Engine] inbound:', e?.message)); });
    c.on('message_create', (msg) => { normalizeOutbound(msg).then((d) => emit('message.outbound', d)).catch((e) => logger.warn?.('[Engine] outbound:', e?.message)); });
    c.on('vote_update', (vote) => { normalizeVote(vote).then((d) => emit('poll.vote', d)).catch((e) => logger.warn?.('[Engine] voto:', e?.message)); });
    return c;
  }

  async function init() {
    if (stopped || client || initializing) return;
    set({ status: 'initializing', ready: false, initAttempts: state.initAttempts + 1 });
    const c = createClient();
    client = c;
    initializing = c;
    timer(() => { if (client === c && state.status === 'initializing') restart(`init travado: sem QR nem conexão em ${Math.round(initTimeoutMs / 1000)}s`); }, initTimeoutMs);
    try {
      await c.initialize();
      if (client !== c) return;
      watchBrowser(c);
      startSyncedSessionKick(c);
    } catch (err) {
      if (client === c) await restart(`falha no init: ${err?.message || err}`);
    } finally {
      if (initializing === c) initializing = null;
    }
  }

  const requireReady = () => { if (!state.ready || !client) throw notSent('NOT_CONNECTED', 'WhatsApp não está conectado'); return client; };

  return {
    state,
    get browserPid() { return browserPid; },
    setSink(fn) { sink = typeof fn === 'function' ? fn : null; },
    async start() { stopped = false; await init(); },
    async stop() {
      stopped = true;
      if (restartTimer) { clearTimer(restartTimer); restartTimer = null; }
      await destroyClient();
      set({ ready: false, status: 'stopped' });
    },
    async getStatus() {
      return {
        status: state.status, ready: state.ready, authenticated: state.authenticated, qrCode: state.qrCode,
        lastDisconnectReason: state.lastDisconnectReason, lastAuthenticatedAt: state.lastAuthenticatedAt,
        qrCount: state.qrCount, initAttempts: state.initAttempts, restarts: state.restarts, updatedAt: state.updatedAt,
      };
    },

    /** Envia texto, ou texto + enquete (opts.poll vindo do CRM). Lança notSent quando nada saiu. */
    async sendMessage(phone, text, opts = {}) {
      const c = requireReady();
      const digits = String(phone || '');
      if (!/^\d{10,15}$/.test(digits)) throw notSent('INVALID_NUMBER', `Número inválido: ${phone}`);
      const numberId = await c.getNumberId(digits);
      if (!numberId) throw notSent('NO_WHATSAPP', `Número ${digits} não possui WhatsApp`);
      const to = numberId._serialized;
      let result;
      if (opts.poll) {
        await c.sendMessage(to, text);
        try {
          if (typeof lib.Poll !== 'function') throw new Error('Poll indisponível nesta versão');
          const poll = new lib.Poll(opts.poll.question, [...opts.poll.options], { allowMultipleAnswers: false });
          result = await c.sendMessage(to, poll, { waitUntilMsgSent: true });
        } catch (pollErr) {
          if (!opts.poll.fallbackText) throw pollErr;
          logger.warn?.('[Engine] enquete indisponível; enviando texto alternativo:', pollErr?.message);
          result = await c.sendMessage(to, opts.poll.fallbackText, { waitUntilMsgSent: true });
        }
      } else {
        result = await c.sendMessage(to, text, { waitUntilMsgSent: true });
      }
      return { success: true, messageId: result?.id?._serialized || null };
    },

    async getChatActivity(phone) {
      const c = requireReady();
      const digits = String(phone || '');
      if (!/^\d{10,15}$/.test(digits)) throw notSent('INVALID_NUMBER', `Número inválido: ${phone}`);
      const numberId = await c.getNumberId(digits);
      if (!numberId) return { exists: false, clinicAt: null, contactAt: null };
      let chat = null;
      try { chat = await c.getChatById(numberId._serialized); } catch { chat = null; }
      if (!chat) return { exists: true, clinicAt: null, contactAt: null };
      let clinicT = 0; let contactT = 0;
      for (const m of (await chat.fetchMessages({ limit: 60 })) || []) {
        const t = Number(m.timestamp) || 0;
        if (m.fromMe) { if (t > clinicT) clinicT = t; } else if (t > contactT) contactT = t;
      }
      return { exists: true, clinicAt: clinicT ? new Date(clinicT * 1000) : null, contactAt: contactT ? new Date(contactT * 1000) : null };
    },

    async readChatActivity({ onlyTails = null } = {}) {
      const c = requireReady();
      const res = await c.pupPage.evaluate(async (tails) => {
        const cols = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
        const loader = window.require?.('WAWebChatLoadMessages');
        const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('__timeout'), ms))]);
        const want = tails ? new Set(tails) : null;
        const chats = (cols.Chat?.getModelsArray?.() || []).filter((ch) => !ch.isGroup && ['c.us', 'lid'].includes(ch.id?.server));
        const out = { rows: [], chats: chats.length, unresolved: 0 };
        for (const chat of chats) {
          const id = chat.id._serialized;
          let phone = chat.id.server === 'c.us' ? chat.id.user : (chat.contact?.phoneNumber?.user || cols.Contact?.get?.(id)?.phoneNumber?.user || null);
          if (!phone && window.WWebJS?.enforceLidAndPnRetrieval) {
            try { const r = await withTimeout(window.WWebJS.enforceLidAndPnRetrieval(id), 3000); phone = r?.phone?.user || null; } catch { /* segue */ }
          }
          if (!phone) { out.unresolved++; continue; }
          if (want && !want.has(String(phone).slice(-8))) continue;
          let msgs = chat.msgs?.getModelsArray?.() || [];
          if (!msgs.length && loader?.loadEarlierMsgs) {
            try { await withTimeout(loader.loadEarlierMsgs({ chat }), 15000); } catch { /* segue */ }
            msgs = chat.msgs?.getModelsArray?.() || [];
          }
          let clinicT = 0; let contactT = 0;
          for (const m of msgs) { const t = m.t || 0; if (m.id?.fromMe) { if (t > clinicT) clinicT = t; } else if (t > contactT) contactT = t; }
          out.rows.push({ phone: String(phone), clinicT, contactT });
        }
        return out;
      }, onlyTails ? [...onlyTails] : null);
      return {
        chats: res.chats,
        unresolved: res.unresolved,
        rows: res.rows.map((r) => ({ phone: r.phone, clinicAt: r.clinicT ? new Date(r.clinicT * 1000) : null, contactAt: r.contactT ? new Date(r.contactT * 1000) : null })),
      };
    },

    /** Um lote da varredura profunda (só leitura). patterns = [[nome, regexSource]] vindos do CRM. */
    async readDeepScanBatch({ startIndex = 0, batchSize = 20, since, maxLoadsPerChat = 80, patterns }) {
      const c = requireReady();
      if (!Array.isArray(patterns) || !patterns.length) throw new Error('patterns obrigatório');
      const sinceDate = since ? new Date(since) : new Date(now() - 3 * 365 * 24 * 3600 * 1000);
      const chatIds = await c.pupPage.evaluate(() => {
        const cols = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
        return (cols.Chat?.getModelsArray?.() || []).filter((ch) => !ch.isGroup && ['c.us', 'lid'].includes(ch.id?.server)).map((ch) => ch.id._serialized).sort();
      });
      const total = chatIds.length;
      if (!total) throw new Error('Não consegui ler a lista de conversas do WhatsApp Web');
      const ids = chatIds.slice(startIndex, startIndex + batchSize);
      const res = await c.pupPage.evaluate(async (idList, pats, sinceTs, maxLoads) => {
        const cols = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
        const regs = pats.map(([name, src]) => [name, new RegExp(src, 'i')]);
        const loader = window.require?.('WAWebChatLoadMessages');
        const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('__timeout'), ms))]);
        const out = { rows: [], unresolved: 0, loadErrors: 0, oldest: null };
        for (const id of idList) {
          const chat = cols.Chat?.get?.(id);
          if (!chat) continue;
          let phone = chat.id.server === 'c.us' ? chat.id.user : (chat.contact?.phoneNumber?.user || cols.Contact?.get?.(id)?.phoneNumber?.user || null);
          if (!phone && window.WWebJS?.enforceLidAndPnRetrieval) {
            try { const r = await window.WWebJS.enforceLidAndPnRetrieval(id); phone = r?.phone?.user || null; } catch { /* segue */ }
          }
          const name = chat.contact?.name || chat.contact?.pushname || chat.formattedTitle || null;
          for (let n = 0; n < maxLoads && loader?.loadEarlierMsgs; n++) {
            const arr = chat.msgs.getModelsArray();
            if (arr.length && (arr[0].t || 0) < sinceTs) break;
            let loaded;
            try { loaded = await withTimeout(loader.loadEarlierMsgs({ chat }), 20000); } catch { out.loadErrors++; break; }
            if (loaded === '__timeout') { out.loadErrors++; break; }
            if (!loaded || !loaded.length) break;
          }
          const msgs = chat.msgs.getModelsArray();
          if (msgs.length && (out.oldest === null || msgs[0].t < out.oldest)) out.oldest = msgs[0].t;
          let hit = false;
          for (const m of msgs) {
            if (!m.body || typeof m.body !== 'string' || (m.t || 0) < sinceTs) continue;
            for (const [cv, re] of regs) {
              if (!re.test(m.body)) continue;
              hit = true;
              if (phone) out.rows.push({ phone: String(phone), convenio: cv, fromMe: Boolean(m.id?.fromMe), body: m.body.slice(0, 500), t: m.t || 0, name });
            }
          }
          if (hit && !phone) out.unresolved++;
          try {
            const all = chat.msgs.getModelsArray();
            if (all.length > 60) { chat.msgs.remove(all.slice(0, all.length - 50)); if (chat.msgs.msgLoadState) chat.msgs.msgLoadState.noEarlierMsgs = false; }
          } catch { /* segue */ }
        }
        return out;
      }, ids, patterns, Math.floor(sinceDate.getTime() / 1000), maxLoadsPerChat);
      return { total, nextIndex: Math.min(startIndex + batchSize, total), ...res };
    },

    async resolveLidsToPhones(lids = []) {
      const c = requireReady();
      const out = [];
      for (const raw of lids.slice(0, 500)) {
        const lid = String(raw).replace(/@lid$/, '');
        let phone = null;
        try {
          const [r] = await c.getContactLidAndPhone([`${lid}@lid`]);
          const pn = r?.pn ? String(r.pn).replace(/@.*$/, '') : null;
          if (isRealBRPhone(pn)) phone = pn;
        } catch { /* segue */ }
        out.push({ lid, phone });
      }
      return out;
    },

    async readPollVotes(messageIds = []) {
      const c = requireReady();
      if (!c.getPollVotes) throw new Error('getPollVotes indisponível nesta versão do whatsapp-web.js');
      const out = [];
      for (const id of messageIds.slice(0, 100)) {
        try {
          const votes = [];
          for (const v of (await c.getPollVotes(String(id))) || []) {
            const n = await normalizeVote(v, String(id));
            if (n) votes.push(n);
          }
          out.push({ pollMessageId: String(id), votes });
        } catch (err) {
          out.push({ pollMessageId: String(id), votes: [], error: err?.message || String(err) });
        }
      }
      return out;
    },

    /** Botão "Gerar novo QR": reinicia o Chrome preservando a sessão; também tira do estado 'failed'/'conflict'. */
    async reconnect() {
      stopped = false;
      restartTimes.length = 0;
      if (restartTimer) { clearTimer(restartTimer); restartTimer = null; }
      await destroyClient();
      set({ ready: false, status: 'restarting', qrCode: null, qrCount: 0, lastDisconnectReason: 'reconexão manual' });
      init().catch(() => {});
      return { success: true, message: 'Reconectando... se pedir, escaneie o novo QR.' };
    },

    /** "Desconectar": faz logout (desvincula o aparelho), apaga a sessão local e sobe pedindo QR novo. */
    async clearSession() {
      const c = client;
      if (c && state.ready) { try { await c.logout(); } catch (e) { logger.warn?.('[Engine] logout:', e?.message); } }
      await destroyClient();
      set({ ready: false, authenticated: false, status: 'restarting', qrCode: null, qrCount: 0, lastAuthenticatedAt: null, lastDisconnectReason: 'sessão limpa' });
      const fs = await import('fs');
      const path = await import('path');
      for (const d of ['session', 'session-default', '.wwebjs_auth']) {
        try { fs.rmSync(path.join(authPath, d), { recursive: true, force: true }); } catch { /* segue */ }
      }
      stopped = false;
      init().catch(() => {});
      return { success: true, message: 'Sessão apagada. Escaneie o QR novo no ERP.' };
    },

    async getPageMemory() {
      const page = client?.pupPage;
      if (!page) return null;
      try {
        const m = await Promise.race([page.metrics(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
        return { jsHeapUsedMB: Math.round((m.JSHeapUsedSize || 0) / 1048576), jsHeapTotalMB: Math.round((m.JSHeapTotalSize || 0) / 1048576) };
      } catch { return null; }
    },

    // Exposto para testes.
    _internals: { normalizeInbound, normalizeOutbound, normalizeVote, restart, get client() { return client; } },
  };
}

export default { createWhatsAppEngine, chromeArgs, notSent };

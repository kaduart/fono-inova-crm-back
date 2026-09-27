// infrastructure/observability/mongoPoolDiagnostics.js
/**
 * Diagnóstico do pool de conexões do MongoDB (somente log — não muda pool, timeouts nem consultas).
 *
 * Objetivo: confirmar em produção se a 1ª carga lenta vem de conexões novas sendo abertas
 * (TCP + TLS + hello + auth ≈ 7 idas ao banco) e por que o pool estava sem conexões livres.
 *
 * Usa os eventos CMAP do driver `mongodb` (6.x), que o MongoClient já emite sem opção extra.
 * Linhas no Render (buscar por "[MongoPool]"):
 *   - conexão criada  → 1 linha quando fica pronta (com o tempo de abertura medido pelo driver)
 *   - conexão fechada → 1 linha, com o motivo do driver: stale | idle | error | poolClosed
 *   - pool limpo / checkout falhou → 1 linha (raros)
 *   - requisição lenta → 1 linha de resumo quando a requisição passa de SLOW_REQUEST_MS
 * Operações normais (checkout/checkin) só atualizam contadores, nunca geram log.
 *
 * Nunca registra URI, host, credenciais, filtros, documentos nem query string:
 * o nó do Atlas vira um rótulo anônimo (n1, n2...) e a rota é o padrão do Express (sem ids).
 *
 * "abertas" conta só as conexões vistas desde que o diagnóstico foi ligado — a conexão
 * aberta durante o mongoose.connect() (ping de autenticação) fica de fora, por isso é aproximado.
 * Uma conexão derrubada pela rede enquanto ociosa só é detectada pelo driver no próximo checkout:
 * o log de fechamento sai nesse momento, e "ociosaS" mostra há quanto tempo ela estava parada.
 */

const SLOW_REQUEST_MS = Number(process.env.MONGO_POOL_SLOW_REQUEST_MS) || 1000;
const ENABLED = process.env.MONGO_POOL_DIAGNOSTICS !== 'false';

const attachedClients = new WeakSet();
const nodeLabels = new Map();          // address → n1, n2...
const connections = new Map();         // `${address}#${id}` → { createdAt, lastCheckInAt }
const checkedOut = new Set();          // `${address}#${id}` em uso agora
let waiting = 0;                       // checkouts aguardando conexão
const activeWindows = new Set();       // requisições em andamento (para o resumo)
const totals = { created: 0, closed: 0 };

function nodeLabel(address) {
    if (!nodeLabels.has(address)) nodeLabels.set(address, `n${nodeLabels.size + 1}`);
    return nodeLabels.get(address);
}

const connKey = (event) => `${event.address}#${event.connectionId}`;
const secondsSince = (ts) => (ts == null ? '?' : Math.round((Date.now() - ts) / 1000));

function forEachWindow(fn) {
    for (const w of activeWindows) fn(w);
}

// Handler de evento nunca pode lançar: roda dentro do código do pool do driver.
function safe(fn) {
    return (event) => {
        try { fn(event); } catch { /* diagnóstico nunca interfere na operação */ }
    };
}

function onConnectionReady(event) {
    const key = connKey(event);
    connections.set(key, { createdAt: Date.now(), lastCheckInAt: null });
    totals.created++;
    forEachWindow(w => { w.created++; w.maxOpen = Math.max(w.maxOpen, connections.size); });
    const setupMs = typeof event.durationMS === 'number' ? Math.round(event.durationMS) : '?';
    console.log(
        `[MongoPool] conexão criada no=${nodeLabel(event.address)} id=${event.connectionId} setupMs=${setupMs} ` +
        `abertas=${connections.size} emUso=${checkedOut.size} fila=${waiting}`
    );
}

function onConnectionClosed(event) {
    const key = connKey(event);
    const info = connections.get(key);
    connections.delete(key);
    checkedOut.delete(key);
    totals.closed++;
    forEachWindow(w => { w.closed++; });
    const errorName = event.error?.name ? ` erro=${event.error.name}` : '';
    const age = info
        ? `vidaS=${secondsSince(info.createdAt)} ociosaS=${secondsSince(info.lastCheckInAt ?? info.createdAt)}`
        : 'vidaS=? (aberta antes do diagnóstico)';
    console.log(
        `[MongoPool] conexão fechada no=${nodeLabel(event.address)} id=${event.connectionId} ` +
        `motivo=${event.reason ?? '?'}${errorName} ${age} abertas=${connections.size}`
    );
}

function onCheckOutStarted() {
    waiting++;
    forEachWindow(w => { w.maxWaiting = Math.max(w.maxWaiting, waiting); });
}

function onCheckedOut(event) {
    waiting = Math.max(0, waiting - 1);
    checkedOut.add(connKey(event));
    const waitMs = typeof event.durationMS === 'number' ? event.durationMS : 0;
    forEachWindow(w => {
        w.maxInUse = Math.max(w.maxInUse, checkedOut.size);
        if (waitMs > w.maxCheckoutWaitMs) w.maxCheckoutWaitMs = waitMs;
    });
}

function onCheckedIn(event) {
    const key = connKey(event);
    checkedOut.delete(key);
    const info = connections.get(key);
    if (info) info.lastCheckInAt = Date.now();
}

function onCheckOutFailed(event) {
    waiting = Math.max(0, waiting - 1);
    const waitMs = typeof event.durationMS === 'number' ? Math.round(event.durationMS) : '?';
    const errorName = event.error?.name ? ` erro=${event.error.name}` : '';
    console.log(`[MongoPool] checkout falhou no=${nodeLabel(event.address)} motivo=${event.reason ?? '?'}${errorName} esperaMs=${waitMs}`);
}

function onPoolCleared(event) {
    console.log(`[MongoPool] pool limpo no=${nodeLabel(event.address)} (conexões existentes marcadas como stale) abertas=${connections.size}`);
}

/**
 * Liga os listeners no MongoClient do mongoose. Idempotente.
 * @param {import('events').EventEmitter} client — mongoose.connection.getClient()
 */
export function attachMongoPoolDiagnostics(client) {
    if (!ENABLED || !client || typeof client.on !== 'function' || attachedClients.has(client)) return false;
    attachedClients.add(client);
    client.on('connectionReady', safe(onConnectionReady));
    client.on('connectionClosed', safe(onConnectionClosed));
    client.on('connectionCheckOutStarted', safe(onCheckOutStarted));
    client.on('connectionCheckedOut', safe(onCheckedOut));
    client.on('connectionCheckedIn', safe(onCheckedIn));
    client.on('connectionCheckOutFailed', safe(onCheckOutFailed));
    client.on('connectionPoolCleared', safe(onPoolCleared));
    // Chamado dentro do try do mongoose.connect no server.js: nunca pode lançar (viraria retry de conexão).
    safe(() => console.log(`[MongoPool] diagnóstico ligado (resumo para requisições > ${SLOW_REQUEST_MS}ms)`))();
    return true;
}

/**
 * Middleware Express: abre uma janela por requisição e, se ela passar de SLOW_REQUEST_MS,
 * registra 1 linha com o que aconteceu no pool do processo durante a requisição.
 * Os números "durante" são do processo inteiro (requisições simultâneas dividem o pool).
 */
export function mongoPoolRequestMiddleware(req, res, next) {
    if (!ENABLED) return next();
    let window;
    try {
        window = {
            startedAt: Date.now(),
            created: 0, closed: 0,
            maxCheckoutWaitMs: 0,
            maxInUse: checkedOut.size, maxWaiting: waiting, maxOpen: connections.size,
        };
        activeWindows.add(window);
        res.once('close', () => {
            try {
                activeWindows.delete(window);
                const ms = Date.now() - window.startedAt;
                if (ms <= SLOW_REQUEST_MS) return;
                // Padrão da rota (ex.: /api/v2/cashflow/) — sem query string nem ids.
                const route = `${req.baseUrl || ''}${req.route?.path ?? ''}` || '(sem rota)';
                const aborted = res.writableFinished ? '' : ' abortada=sim';
                console.log(
                    `[MongoPool] requisição lenta ${req.method} ${route} ${ms}ms status=${res.statusCode}${aborted} | ` +
                    `processo durante: criadas=${window.created} fechadas=${window.closed} ` +
                    `esperaCheckoutMaxMs=${Math.round(window.maxCheckoutWaitMs)} emUsoMax=${window.maxInUse} ` +
                    `filaMax=${window.maxWaiting} abertasMax=${window.maxOpen} | ` +
                    `ao fim: abertas=${connections.size} emUso=${checkedOut.size}`
                );
            } catch { /* diagnóstico nunca interfere na resposta */ }
        });
    } catch { /* idem */ }
    next();
}

/** Somente para testes. */
export function _resetMongoPoolDiagnosticsForTests() {
    nodeLabels.clear(); connections.clear(); checkedOut.clear(); activeWindows.clear();
    waiting = 0; totals.created = 0; totals.closed = 0;
}

export function getMongoPoolSnapshot() {
    return { open: connections.size, inUse: checkedOut.size, waiting, ...totals };
}

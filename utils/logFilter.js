// utils/logFilter.js
// 10/11: módulo separado e importado PRIMEIRO no server.js. Em ESM os imports rodam antes
// do corpo do arquivo, então o filtro dentro do server.js só pegava logs de runtime — os de
// boot ([Queue:x] Inicializada, AppointmentWriteGuard...) já tinham saído.
// ======================================================
// 🔇 FILTRO DE LOG — suprime ruído de startup/workers
// Editar SUPPRESS_PATTERNS para ajustar o que silenciar.
// console.error sempre passa. LOG_VERBOSE=true desativa o filtro.
// ======================================================
if (process.env.LOG_VERBOSE !== 'true') {
    const SUPPRESS_PATTERNS = [
        /^\[Queue:/,                      // Queue:xyz Inicializada
        /^\[Registry\]/,                  // Registry start/ok
        /^🔄 Redis retry/,                // Redis retry tentativas
        /^\[CronManager\]/,               // Cron startup
        /Worker (iniciado|criado|pronto|registrado|Started)/i,
        /^⚡ Novo cliente conectado/,      // socket connections
        /^👥 Total de clientes/,           // socket count
        /^\[INSTANCE INFO\]|^🖥️ INSTANCE/,
        /^\[QueueConfig\] Reutilizando/,
        /^\[IO INIT\]/,
        /^IO INIT:/,
        /Inicializada \(modo manual\)/,
        /^\[Workers\] Iniciando|Workers 4\.0|Workers ATIVADOS/,
        /^\[Registry\] Workers ativos/,
        /^\[whatsapp_guard\].*whatsapp_guard_started/,
        /^\[whatsapp_guard\].*whatsapp_critical_pending/,  // repetitivo — ver no alerta
        /^\[conversationStateWorker\]|^\[contextBuilderWorker\]|^\[whatsappAutoReplyWorker\]/,
        /^\[Server\] (ENABLE_WORKERS|WORKER_GROUP)/,  // debug de env no boot
        /^\[AppointmentWriteGuard\] Interceptores instalados/,
    ];
    // 10/11 (Kadu: "log muito poluído"): cronômetros por etapa, cache HIT/SET e contagens
    // que saem a CADA requisição do dashboard. Escondidos por padrão; LOG_PERF=true mostra.
    // O resumo "[MongoPool] requisição lenta" continua sempre visível (é o sinal útil).
    if (process.env.LOG_PERF !== 'true') SUPPRESS_PATTERNS.push(
        /^\[(realTime|profissionais|pendentes|by-type|buildStats|FinancialDashboard|calculate\w+|unifiedFinancialService|getInsuranceGuidesView|doctorsOverviewBuilder|upcomingBuilder|ANIVERSARIANTES|Calendar|ExpenseV\d|DashboardV\d|commercial\.v\d|analytics\/by-type)\]/,
        /^\[DashboardCache\] (MISS|HIT|🔥)/,
        /^\[Planning GET\]/,
        /^\[GET \/appointments\]/,
        /^\[MongoPool\] conexão criada/,
        /^\{"level":"metric"/,
        /^(Mês: \d+\/\d+ \| Início|Status: (PASSADO|ATUAL|FUTURO)$)/,  // provisionamento
        /^⚠️ Cliente desconectado \((transport close|ping timeout|client namespace disconnect)\)/,  // aba fechada/HMR
    );
    const _log = console.log.bind(console);
    const _warn = console.warn.bind(console);
    console.log = (...args) => {
        const msg = String(args[0] ?? '');
        if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return;
        _log(...args);
    };
    console.warn = (...args) => {
        const msg = String(args[0] ?? '');
        if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return;
        _warn(...args);
    };
}

// crons/fixedExpenseGeneration.cron.js
/**
 * FLOW REFERENCE: back/docs/ARCHITECTURE_FLOW.md
 * Domínio: Despesa (Expense / FixedExpense)
 * Fluxo: geração mensal das despesas fixas (competência corrente)
 *
 * Gera sozinho as ocorrências (Expense `pending`) dos modelos de despesa fixa ativos,
 * garantindo que o MÊS CORRENTE esteja sempre completo. Nunca gera meses passados.
 *
 * Onde roda: `startAllCrons()` (config/cronManager.js) → processo crm-backend (24h).
 * NÃO é cron do crm-worker, então a janela seg–sex 08:00–19:00 (ADR-022 / invariante #30)
 * não se aplica e não há regra de dia útil/feriado: criar despesa pendente em fim de semana
 * é inofensivo.
 *
 * Robustez (node-cron NÃO recupera disparo perdido — ADR-022):
 *   - roda a cada 6h (00:20, 06:20, 12:20, 18:20 BRT) — é idempotente e barato
 *     (uma consulta quando nada falta);
 *   - catch-up único ~90 s depois do boot (cobre deploy/restart na hora do cron);
 *   - botão "Gerar fixas do mês" na aba Despesas continua como reserva.
 *
 * Concorrência: lock Redis por competência + idempotência do próprio serviço
 * (diff + índice único parcial + E11000). `server.js` e `cron-worker.js` chamam
 * startAllCrons — se os dois estiverem de pé, o lock/idempotência cobrem a duplicidade.
 */
import cron from 'node-cron';
import moment from 'moment-timezone';
import { generateForMonth, SYSTEM_ACTOR } from '../services/fixedExpense.service.js';
import { acquireLock, releaseLock } from '../utils/redisLock.js';
import { sendAlert } from '../infrastructure/alerts/alertService.js';
import { logMetric } from '../utils/logMetric.js';
import { TIMEZONE, toCompetenceMonth } from '../utils/fixedExpenseDates.js';

const TAG = '[FixedExpenseCron]';
const LOCK_TTL_SECONDS = 300;
const BOOT_CATCHUP_MS = 90_000;
const SCHEDULE = '20 */6 * * *';

async function safeAlert(payload) {
    try {
        await sendAlert(payload);
    } catch (err) {
        console.error(`${TAG} falha ao enviar alerta:`, err.message);
    }
}

/**
 * Completa as despesas fixas do mês corrente (fuso America/Sao_Paulo).
 * Idempotente. `now` é injetável para teste.
 * @returns {{ status: 'generated'|'nothing'|'locked'|'error', competenceMonth, created?, skipped?, errors? }}
 */
export async function ensureFixedExpensesForCurrentMonth({ now = new Date() } = {}) {
    const startedAt = Date.now();
    const local = moment.tz(now, TIMEZONE);
    const year = local.year();
    const month = local.month() + 1;
    const competenceMonth = toCompetenceMonth(year, month);
    const lockResource = `fixed-expense-generate:${competenceMonth}`;

    // Lock por competência. Redis indisponível NÃO pode impedir a geração: ela é idempotente
    // (diff + índice único parcial), então segue sem lock. Lock já preso = outra instância gerando.
    let lockToken = null;
    try {
        lockToken = await acquireLock(lockResource, LOCK_TTL_SECONDS);
        if (!lockToken) {
            console.log(`${TAG} ${competenceMonth}: outra instância já está gerando — pulando`);
            return { status: 'locked', competenceMonth };
        }
    } catch (lockErr) {
        console.warn(`${TAG} lock indisponível (${lockErr.message}) — gerando sem lock`);
    }

    let result;
    try {
        result = await generateForMonth({ year, month }, SYSTEM_ACTOR);
    } catch (err) {
        console.error(`${TAG} ERRO ${competenceMonth}:`, err.message);
        await safeAlert({
            level: 'critical',
            type: 'fixed_expense_generation_failed',
            message: `🚨 Falha ao gerar as despesas fixas de ${competenceMonth}: ${err.message}`,
            details: { competenceMonth, error: err.message }
        });
        return { status: 'error', competenceMonth, error: err.message };
    } finally {
        if (lockToken) await releaseLock(lockResource, lockToken).catch(() => {});
    }

    const { created, skipped, errors } = result;
    logMetric('FixedExpenseCron', 'ensure_current_month', {
        competenceMonth,
        created: created.length,
        skipped: skipped.length,
        errors: errors.length,
        executionTimeMs: Date.now() - startedAt
    });

    if (errors.length > 0) {
        await safeAlert({
            level: 'critical',
            type: 'fixed_expense_generation_failed',
            message: `🚨 ${errors.length} despesa(s) fixa(s) de ${competenceMonth} falharam ao gerar`,
            details: { competenceMonth, errors }
        });
        return { status: 'error', competenceMonth, created, skipped, errors };
    }

    return { status: created.length > 0 ? 'generated' : 'nothing', competenceMonth, created, skipped, errors };
}

export function scheduleFixedExpenseGeneration() {
    const task = cron.schedule(SCHEDULE, () => {
        ensureFixedExpensesForCurrentMonth().catch((err) =>
            console.error(`${TAG} erro não tratado:`, err.message));
    }, { timezone: TIMEZONE });

    // Catch-up: node-cron não recupera disparo perdido (deploy/restart na hora do cron).
    const bootTimer = setTimeout(() => {
        ensureFixedExpensesForCurrentMonth().catch((err) =>
            console.error(`${TAG} erro não tratado (catch-up):`, err.message));
    }, BOOT_CATCHUP_MS);
    bootTimer.unref?.();

    console.log(`${TAG} Agendado: ${SCHEDULE} (America/Sao_Paulo) + catch-up ${BOOT_CATCHUP_MS / 1000}s após o boot`);

    return {
        stop: () => {
            task.stop();
            clearTimeout(bootTimer);
        }
    };
}

import { resolveSessionFinancialValue } from '../../../utils/resolveSessionFinancialValue.js';

// 🐛 FIX (2026-09-16): faltava 'pre_agendado' — invariante do domínio (CLAUDE.md/
// DOMAIN_INVARIANTS.md, ADR-006) exige que TODO filtro de agendamentos ativos
// inclua 'pre_agendado' além de scheduled/confirmed. Sem isso, agendamentos ainda
// não confirmados (inclui sessões de convênio recém-geradas por replanejamento,
// que nascem em pre_agendado) sumiam da contagem — nem "realizados" nem
// "faltantes" — fazendo o resumo do dia (ex: "2 atendidos · 4 aguardando")
// mostrar um total bem menor que a agenda real do dia.
const remainingStatuses = new Set(['pre_agendado', 'scheduled', 'confirmed', 'pending', 'paid', 'processing_complete']);

// Contagem operacional, independente de recebimentos e valores de produção.
export function summarizeCashflowAttendance(appointments) {
    const summary = { realizados: 0, faltantes: 0 };
    for (const appointment of appointments) {
        if (appointment.operationalStatus === 'completed') {
            summary.realizados++;
        } else if (
            remainingStatuses.has(appointment.operationalStatus) &&
            appointment.missed !== true &&
            appointment.clinicalStatus !== 'missed'
        ) {
            summary.faltantes++;
        }
    }
    return { ...summary, total: summary.realizados + summary.faltantes };
}

// Valor previsto da agenda do período (valuation oficial: docs/FINANCIAL_CONTRACT.md §3): soma do valor da sessão de tudo que foi
// atendido ou ainda vai acontecer (inclui pre_agendado). Faltas e cancelamentos
// ficam de fora do previsto e entram em `perdido`.
export function summarizeCashflowAgendaValue(appointments) {
    const out = { previsto: 0, sessoes: 0, perdido: 0, faltasOuCancelados: 0 };
    for (const appointment of appointments) {
        const missed = appointment.missed === true || appointment.clinicalStatus === 'missed';
        if (appointment.operationalStatus === 'canceled' || (missed && appointment.operationalStatus !== 'completed')) {
            out.perdido += resolveSessionFinancialValue(appointment);
            out.faltasOuCancelados++;
        } else if (appointment.operationalStatus === 'completed' || remainingStatuses.has(appointment.operationalStatus)) {
            out.previsto += resolveSessionFinancialValue(appointment);
            out.sessoes++;
        }
    }
    return out;
}

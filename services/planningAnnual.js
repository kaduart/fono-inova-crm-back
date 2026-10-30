/**
 * Metas do ano: as 12 metas mensais lado a lado com o realizado de cada mês.
 *
 * O realizado usa a mesma regra da Meta Realizada do painel (calculateMetaRealizada:
 * caixa menos convênio retroativo menos liminar), para os números baterem com Indicadores.
 * Mês futuro não tem realizado. O mês corrente conta até agora.
 *
 * Somente leitura.
 */
import moment from 'moment-timezone';
import Planning from '../models/Planning.js';
import { calculateMetaRealizada } from './unifiedFinancialService.v2.js';

const TZ = 'America/Sao_Paulo';
const round = n => Math.round((Number(n) || 0) * 100) / 100;

export function monthStatus({ meta, realizado, isFuture, isCurrent, percentualEsperado }) {
    if (isFuture) return meta > 0 ? 'futuro' : 'sem_meta';
    if (!(meta > 0)) return 'sem_meta';
    if (realizado >= meta) return 'batida';
    if (isCurrent) return (realizado / meta) * 100 >= percentualEsperado ? 'no_ritmo' : 'abaixo_do_ritmo';
    return 'nao_batida';
}

export async function getAnnualPlanning(year) {
    const now = moment.tz(TZ);
    const y = Number(year) || now.year();

    const plannings = await Planning.find({
        type: 'monthly',
        'period.start': { $gte: `${y}-01-01`, $lte: `${y}-12-31` }
    }).select('period targets actual progress').lean();

    // Uma meta por mês (se houver duplicada, vale a de maior receita esperada, que é a que a tela mostrava).
    const byMonth = new Map();
    for (const p of plannings) {
        const m = Number(String(p.period?.start || '').slice(5, 7));
        if (!m) continue;
        const prev = byMonth.get(m);
        if (!prev || (p.targets?.expectedRevenue || 0) > (prev.targets?.expectedRevenue || 0)) byMonth.set(m, p);
    }

    const months = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
        const month = i + 1;
        const base = moment.tz([y, i], TZ);
        const isFuture = base.isAfter(now, 'month');
        const isCurrent = base.isSame(now, 'month');
        const p = byMonth.get(month);
        const meta = round(p?.targets?.expectedRevenue);

        let realizado = null;
        if (!isFuture) {
            const start = base.clone().startOf('month').utc().toDate();
            const end = isCurrent ? now.clone().endOf('day').utc().toDate() : base.clone().endOf('month').utc().toDate();
            realizado = round((await calculateMetaRealizada(start, end)).total);
        }
        const percentualEsperado = isCurrent ? round((now.date() / now.daysInMonth()) * 100) : isFuture ? 0 : 100;
        const percentual = meta > 0 && realizado != null ? round((realizado / meta) * 100) : null;

        return {
            month,
            planningId: p?._id ?? null,
            meta,
            metaSessoes: p?.targets?.totalSessions || 0,
            sessoesRealizadas: p?.actual?.completedSessions ?? null,
            realizado,
            percentual,
            percentualEsperado,
            falta: meta > 0 && realizado != null ? round(Math.max(0, meta - realizado)) : null,
            isCurrent,
            isFuture,
            status: monthStatus({ meta, realizado, isFuture, isCurrent, percentualEsperado })
        };
    }));

    const passados = months.filter(m => !m.isFuture);
    const metaAno = round(months.reduce((s, m) => s + m.meta, 0));
    const realizadoAno = round(passados.reduce((s, m) => s + (m.realizado || 0), 0));
    // Meta até agora: meses fechados inteiros + o mês corrente proporcional aos dias.
    const metaAteAgora = round(passados.reduce((s, m) => s + (m.isCurrent ? m.meta * m.percentualEsperado / 100 : m.meta), 0));

    return {
        year: y,
        months,
        totals: {
            metaAno,
            realizadoAno,
            percentualAno: metaAno > 0 ? round((realizadoAno / metaAno) * 100) : null,
            metaAteAgora,
            diferencaAteAgora: round(realizadoAno - metaAteAgora),
            mesesComMeta: months.filter(m => m.meta > 0).length,
            mesesBatidos: months.filter(m => m.status === 'batida').length,
            mesesFechados: passados.filter(m => !m.isCurrent).length
        }
    };
}

export default { getAnnualPlanning };

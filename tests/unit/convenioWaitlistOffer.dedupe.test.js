import { beforeEach, describe, expect, it, vi } from 'vitest';

// planBulkOffer sem banco: o model e o cruzamento com pacientes são simulados.
const rows = [];
const busyDocs = [];
const counts = { sent: 0, contatado: 0, today: 0 };
vi.mock('../../models/ConvenioWaitlist.js', () => ({
    default: {
        find: () => ({ select: () => ({ sort: () => ({ lean: async () => rows }), lean: async () => busyDocs }) }),
        countDocuments: async (q) => {
            if (q.$or) return counts.today;
            if (q.status === 'contatado') return counts.contatado;
            return counts.sent;
        },
    },
}));
vi.mock('../../services/convenioWaitlistWhatsapp.js', () => ({
    patientMatchesByPhone: async (phones) => new Map(phones.filter((p) => p.endsWith('0003')).map((p) => [p, { nextAppointmentAt: new Date() }])),
}));

const { planBulkOffer, isRecentClinicChat, scheduleSlots, OFFER_DAILY_CAP } = await import('../../services/convenioWaitlistOffer.js');

// 12/11/2026 (quinta) 10h em São Paulo
const now = new Date(Date.UTC(2026, 10, 12, 13, 0));
const daysAgo = (d) => new Date(now.getTime() - d * 24 * 3600 * 1000);
const row = (id, phone, extra = {}) => ({ _id: id, name: `Pessoa ${id}`, phone, convenio: 'unimed', createdAt: daysAgo(200), whatsapp: {}, ...extra });

describe('envio em massa não repete contato', () => {
    beforeEach(() => {
        rows.length = 0;
        Object.assign(counts, { sent: 5, contatado: 2, today: 0 });
    });

    it('tira quem conversou com a clínica há pouco e quem tem sessão; mostra o motivo', async () => {
        rows.push(
            row('a', '5562900000001'),
            row('b', '5562900000002', { whatsapp: { lastClinicMessageAt: daysAgo(3) } }), // equipe falou na mão
            row('c', '5562900000003'), // sessão marcada
            row('d', '5562900000004', { whatsapp: { lastClinicMessageAt: daysAgo(90) } }), // conversa antiga: recebe
        );
        const plan = await planBulkOffer({ kind: 'particular', convenio: 'unimed', now });
        expect(plan.batch.map((g) => g._id)).toEqual(['a', 'd']);
        expect(plan.skippedRecentChat).toBe(1);
        expect(plan.skippedWithSession).toBe(1);
        expect(plan.skipped.map((p) => [p.id, p.reason])).toEqual([['b', 'conversa_recente'], ['c', 'sessao_futura']]);
        expect(plan.alreadySent).toBe(5);
        expect(plan.markedContatado).toBe(2);
        expect(plan.recipients.every((p) => p.today)).toBe(true);
        expect(plan.recipients[0].phoneTail).toBe('0001');
    });

    it('desmarcado na tela não recebe e o próximo entra no lugar', async () => {
        for (let i = 1; i <= 45; i++) rows.push(row(`p${i}`, `55629000${String(i).padStart(5, '0')}`.replace(/0003$/, '0099')));
        const plan = await planBulkOffer({ kind: 'particular', now, excludeIds: ['p1'] });
        expect(plan.unchecked).toBe(1);
        expect(plan.batch).toHaveLength(44); // um clique agenda todos
        expect(plan.todayCount).toBe(40);
        expect(plan.days).toBe(2);
        expect(plan.batch[0]._id).toBe('p2');
        expect(plan.batch.some((g) => g._id === 'p1')).toBe(false);
        expect(plan.recipients.find((p) => p.id === 'p1')).toMatchObject({ excluded: true, today: false });
        expect(plan.recipients.find((p) => p.id === 'p45').today).toBe(false); // fica para amanhã
    });

    it('mesmo telefone em dois cadastros: 1 mensagem e vale a conversa mais recente', async () => {
        rows.push(
            row('x', '5562900000010'),
            { ...row('y', '5562900000010'), whatsapp: { lastClinicMessageAt: daysAgo(1) } },
        );
        const plan = await planBulkOffer({ kind: 'particular', now });
        expect(plan.batch).toHaveLength(0);
        expect(plan.skippedRecentChat).toBe(1);
    });
});

describe('trava do worker antes de enviar', () => {
    it('pula se a clínica mandou mensagem dentro da janela', () => {
        expect(isRecentClinicChat({ clinicAt: daysAgo(2) }, 30, now)).toBe(true);
        expect(isRecentClinicChat({ clinicAt: daysAgo(40) }, 30, now)).toBe(false);
        expect(isRecentClinicChat({ clinicAt: null }, 30, now)).toBe(false);
        expect(isRecentClinicChat(null, 30, now)).toBe(false);
    });
});

describe('scheduleSlots (todos de uma vez, espalhado em dias úteis)', () => {
    const at = (y, m, d, hh, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh + 3, mm)); // SP
    const day = (x) => new Date(x.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    it('102 da Unimed numa quinta 15h: o que cabe hoje, depois sexta e segunda, nunca fim de semana', () => {
        const slots = scheduleSlots({ count: 102, now: at(2026, 11, 12, 15), random: () => 0.5 });
        expect(slots).toHaveLength(102);
        const perDay = {};
        for (const s of slots) perDay[day(s)] = (perDay[day(s)] || 0) + 1;
        expect(Object.keys(perDay)).not.toContain('2026-11-14');
        expect(Object.keys(perDay)).not.toContain('2026-11-15');
        expect(Math.max(...Object.values(perDay))).toBeLessThanOrEqual(OFFER_DAILY_CAP);
        for (const s of slots) {
            const m = (s.getUTCHours() - 3) * 60 + s.getUTCMinutes();
            expect(m).toBeGreaterThanOrEqual(8 * 60);
            expect(m).toBeLessThan(18 * 60 + 45);
        }
        expect(slots[0].getTime()).toBe(at(2026, 11, 12, 15).getTime());
    });
    it('respeita o que já está agendado no dia', () => {
        const busy = Array.from({ length: OFFER_DAILY_CAP }, (_, i) => at(2026, 11, 12, 9, i));
        const slots = scheduleSlots({ count: 1, now: at(2026, 11, 12, 10), busy, random: () => 0.5 });
        expect(day(slots[0])).toBe('2026-11-13');
    });
});

// Prévia do "Retomar contato" pós-avaliação sem banco: models simulados.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = { evals: [], later: [], packages: [], future: [], patients: [], lost: [], sent: [], messages: [], busy: [] };
const chain = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
vi.mock('../../models/Appointment.js', () => ({
    default: {
        aggregate: async () => [],
        // janela das avaliações (date.$lte) x atendimentos depois dela
        find: (q) => (q.date?.$lte ? { sort: () => ({ lean: async () => db.evals }) } : chain(db.later)),
        distinct: async () => db.future,
        exists: async () => db.apptExists,
    },
}));
vi.mock('../../models/Package.js', () => ({ default: { find: () => chain(db.packages), exists: async () => db.pkgExists } }));
vi.mock('../../models/Patient.js', () => ({ default: { find: () => chain(db.patients) } }));
vi.mock('../../models/Message.js', () => ({ default: { aggregate: async () => db.messages } }));
vi.mock('../../models/CommercialContact.js', () => ({ default: { distinct: async () => db.lost } }));
vi.mock('../../models/EvaluationReengagement.js', () => ({ default: { find: (q) => chain(q.evaluation ? db.sent : db.busy) } }));
vi.mock('../../models/ConvenioWaitlist.js', () => ({ default: { find: () => chain([]) } }));

const { planReengagement, hasContinuedSince } = await import('../../services/commercial/evaluationReengagement.js');

// 12/11/2026 (quinta) 10h em São Paulo
const now = new Date(Date.UTC(2026, 10, 12, 13, 0));
const daysAgo = (d) => new Date(now.getTime() - d * 24 * 3600 * 1000);
const evalRow = (pid, days, specialty = 'fonoaudiologia') => ({ _id: `ev-${pid}`, patient: pid, date: daysAgo(days), specialty, serviceType: 'evaluation' });
const patient = (id, phone, extra = {}) => ({ _id: id, fullName: `Paciente ${id}`, phone, status: 'active', ...extra });

describe('planReengagement', () => {
    beforeEach(() => {
        for (const k of Object.keys(db)) db[k] = [];
    });

    it('lista quem sumiu, junta irmãos do mesmo telefone e mostra quem fica de fora e por quê', async () => {
        db.evals = [evalRow('a', 40), evalRow('b', 100), evalRow('c', 50), evalRow('d', 70), evalRow('e', 80), evalRow('f', 90), evalRow('g', 45)];
        db.later = [{ _id: 'x', patient: 'g', date: daysAgo(20) }]; // g voltou: deu continuidade
        db.patients = [
            patient('a', '(62) 99000-0001'),
            patient('b', '62 99000-0001'), // irmão de a (mesmo celular)
            patient('c', ''), // sem telefone
            patient('d', '62990000004', { status: 'inactive', inactivation: { reason: 'mudou_cidade' } }),
            patient('e', '62990000005'),
            patient('f', '62990000006'),
            patient('g', '62990000007'),
        ];
        db.lost = ['e']; // marcado "Não vai fechar"
        db.messages = [{ _id: { to: '5562990000006', from: 'x' }, at: daysAgo(5) }]; // equipe falou há 5 dias
        const plan = await planReengagement({ period: 'all', now });
        expect(plan.batch).toHaveLength(1);
        expect(plan.batch[0].phone).toBe('5562990000001');
        expect(plan.recipients[0].name).toBe('Paciente a e Paciente b');
        expect(plan.sample).toContain('com *Paciente e Paciente*'); // primeiro nome de cada
        expect(plan.skipped.map((s) => [s.id, s.reason]).sort()).toEqual([
            ['c', 'sem_telefone'], ['d', 'inativo'], ['e', 'nao_vai_fechar'], ['f', 'conversa_recente'],
        ]);
        expect(plan.recipients[0].today).toBe(true);
    });

    it('quem já recebeu por esta avaliação não entra de novo', async () => {
        db.evals = [evalRow('a', 40)];
        db.patients = [patient('a', '62990000001')];
        db.sent = [{ evaluation: 'ev-a', queuedAt: daysAgo(1) }];
        const plan = await planReengagement({ period: 30, now });
        expect(plan.batch).toHaveLength(0);
        expect(plan.alreadySent).toBe(1);
    });

    it('desmarcado na tela não recebe', async () => {
        db.evals = [evalRow('a', 40), evalRow('b', 41)];
        db.patients = [patient('a', '62990000001'), patient('b', '62990000002')];
        const plan = await planReengagement({ period: 15, excludeIds: ['a'], now });
        expect(plan.batch.map((t) => t.id)).toEqual(['b']);
        expect(plan.unchecked).toBe(1);
    });
});

describe('hasContinuedSince (trava do worker)', () => {
    beforeEach(() => { for (const k of Object.keys(db)) db[k] = []; db.apptExists = null; db.pkgExists = null; });
    it('agendou depois do clique: não manda', async () => {
        db.sent = [{ patient: 'a', evaluatedAt: daysAgo(40) }];
        db.apptExists = { _id: 'x' };
        expect(await hasContinuedSince(['ev-a'])).toBe(true);
    });
    it('fechou pacote depois: não manda', async () => {
        db.sent = [{ patient: 'a', evaluatedAt: daysAgo(40) }];
        db.pkgExists = { _id: 'p' };
        expect(await hasContinuedSince(['ev-a'])).toBe(true);
    });
    it('continua sumido: manda', async () => {
        db.sent = [{ patient: 'a', evaluatedAt: daysAgo(40) }];
        expect(await hasContinuedSince(['ev-a'])).toBe(false);
    });
});

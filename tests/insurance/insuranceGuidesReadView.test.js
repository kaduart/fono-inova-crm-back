// tests/insurance/insuranceGuidesReadView.test.js
/**
 * insuranceGuidesReadView — fonte de leitura composta da aba Convênios.
 *
 * Trava o bug que motivou a refatoração (auditoria 2026-08-07): a leitura antiga
 * partia da sessão pendente, então guia totalmente faturada sumia da tela — 59 de
 * 112 guias em prod. E o `billingState` escalar colapsava guia com sessões em
 * fases diferentes (9 guias reais em billingMode 'per_month') para um estado só,
 * apagando a parte já faturada.
 *
 * Testes de composição pura aqui; a invariante de completude contra o banco real
 * roda em scripts/reconcile-insurance-guides-view.mjs (Fase 2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import '../../models/index.js';
import {
    deriveSessionPhase,
    deriveBillingLabel,
    hasMixedStates,
    composeGuideAggregates,
    composePendingCompetenceBreakdown,
    competenceDateFor,
    resolvePaymentForSession,
    resolveSessionValue,
    SessionPhase,
    GuideBillingLabel
} from '../../services/insuranceGuide/insuranceGuidesReadView.js';

const completed = (extra = {}) => ({ status: 'completed', ...extra });

const PHASES = [
    SessionPhase.PENDING_BILLING,
    SessionPhase.DOCUMENTATION_SENT,
    SessionPhase.BILLED,
    SessionPhase.RECEIVED
];

describe('🛡️ resolvePaymentForSession() — integridade antes da fase', () => {
    it('Payment void não é oferecido para faturamento', () => {
        const result = resolvePaymentForSession([{
            _id: 'payment-void',
            status: 'void',
            amount: 80,
            insurance: { status: 'pending', grossAmount: 80 }
        }]);

        assert.strictEqual(result.payment, null);
        assert.strictEqual(result.activePayments, 0);
        assert.strictEqual(result.integrityConflict, true);
    });

    it('aceita exatamente um Payment de convênio pendente de faturamento', () => {
        const payment = {
            _id: 'payment-active',
            status: 'pending',
            amount: 80,
            insurance: { status: 'pending_billing', grossAmount: 80 }
        };
        const result = resolvePaymentForSession([payment]);

        assert.strictEqual(result.payment, payment);
        assert.strictEqual(result.activePayments, 1);
        assert.strictEqual(result.integrityConflict, false);
    });
});

describe('🏥 deriveSessionPhase() — a fase vive na sessão', () => {
    it('sessão completed sem nada => pendingBilling', () => {
        assert.strictEqual(
            deriveSessionPhase(completed(), null, false),
            SessionPhase.PENDING_BILLING
        );
    });

    it('guia com documentação enviada => documentationSent', () => {
        assert.strictEqual(
            deriveSessionPhase(completed(), null, true),
            SessionPhase.DOCUMENTATION_SENT
        );
    });

    it('sessão com billingBatchId => billed, mesmo com documentação enviada', () => {
        assert.strictEqual(
            deriveSessionPhase(completed({ billingBatchId: 'batch1' }), null, true),
            SessionPhase.BILLED
        );
    });

    it('fluxo legado sem billingBatchId: Payment billed também conta como billed', () => {
        assert.strictEqual(
            deriveSessionPhase(completed(), { insurance: { status: 'billed' } }, false),
            SessionPhase.BILLED
        );
    });

    it('Payment received => received, vence billed', () => {
        assert.strictEqual(
            deriveSessionPhase(
                completed({ billingBatchId: 'batch1' }),
                { insurance: { status: 'received' } },
                true
            ),
            SessionPhase.RECEIVED
        );
    });

    it('sessão não completed fica FORA do ciclo (null), não vira pendingBilling', () => {
        assert.strictEqual(deriveSessionPhase({ status: 'scheduled' }, null, false), null);
        assert.strictEqual(deriveSessionPhase({ status: 'canceled' }, null, false), null);
    });
});

describe('🏷️ deriveBillingLabel() — rótulo visual, não fonte de verdade', () => {
    const counters = (o = {}) => ({
        pendingBilling: 0, documentationSent: 0, billed: 0, received: 0, ...o
    });

    it('guia sem sessão no ciclo => no_sessions (mas a guia NÃO some)', () => {
        assert.strictEqual(deriveBillingLabel(counters()), GuideBillingLabel.NO_SESSIONS);
    });

    it('uma fase só => rótulo daquela fase', () => {
        assert.strictEqual(deriveBillingLabel(counters({ pendingBilling: 3 })), GuideBillingLabel.PENDING);
        assert.strictEqual(deriveBillingLabel(counters({ billed: 4 })), GuideBillingLabel.BILLED);
        assert.strictEqual(deriveBillingLabel(counters({ received: 1 })), GuideBillingLabel.RECEIVED);
        assert.strictEqual(
            deriveBillingLabel(counters({ documentationSent: 2 })),
            GuideBillingLabel.DOCUMENTATION_SENT
        );
    });

    it('CONTRATO: "mixed" não existe como rótulo — mistura não é estado de negócio', () => {
        assert.strictEqual(GuideBillingLabel.MIXED, undefined);
        assert.ok(
            !Object.values(GuideBillingLabel).includes('mixed'),
            'nenhum valor de GuideBillingLabel pode ser "mixed"'
        );
    });

    it('REGRESSÃO: com várias fases, o rótulo é a MENOS avançada (próxima ação)', () => {
        // guia per_month com parte faturada e parte a faturar: rotular "billed"
        // esconderia as 3 sessões que ainda precisam ser faturadas.
        assert.strictEqual(
            deriveBillingLabel(counters({ pendingBilling: 3, billed: 4 })),
            GuideBillingLabel.PENDING
        );
        // exemplo aprovado: billed + received + pending simultâneos
        assert.strictEqual(
            deriveBillingLabel(counters({ pendingBilling: 1, billed: 1, received: 1 })),
            GuideBillingLabel.PENDING
        );
        // sem pendência: a menos avançada passa a ser documentação enviada
        assert.strictEqual(
            deriveBillingLabel(counters({ documentationSent: 2, billed: 4, received: 1 })),
            GuideBillingLabel.DOCUMENTATION_SENT
        );
        // caso real da guia 16007195: 7 faturadas + 4 com documentação enviada
        assert.strictEqual(
            deriveBillingLabel(counters({ documentationSent: 4, billed: 7 })),
            GuideBillingLabel.DOCUMENTATION_SENT
        );
    });

    it('guia fechada manualmente vence qualquer fase', () => {
        assert.strictEqual(
            deriveBillingLabel(counters({ pendingBilling: 2, billed: 5 }), { isClosed: true }),
            GuideBillingLabel.CLOSED
        );
    });
});

describe('🔀 hasMixedStates() — característica da guia, não estado', () => {
    const counters = (o = {}) => ({
        pendingBilling: 0, documentationSent: 0, billed: 0, received: 0, ...o
    });

    it('uma fase só => false', () => {
        assert.strictEqual(hasMixedStates(counters({ billed: 9 })), false);
    });

    it('nenhuma fase => false', () => {
        assert.strictEqual(hasMixedStates(counters()), false);
    });

    it('duas ou mais fases => true', () => {
        assert.strictEqual(hasMixedStates(counters({ pendingBilling: 3, billed: 4 })), true);
        assert.strictEqual(hasMixedStates(counters({ pendingBilling: 1, billed: 1, received: 1 })), true);
    });

    it('a informação perdida pelo rótulo continua recuperável pelos contadores', () => {
        const c = counters({ pendingBilling: 4, documentationSent: 2, billed: 7, received: 1 });
        assert.strictEqual(deriveBillingLabel(c), GuideBillingLabel.PENDING);
        assert.strictEqual(hasMixedStates(c), true);
        // o rótulo diz "pending", mas as 7 faturadas seguem visíveis:
        assert.strictEqual(c.billed, 7);
        assert.strictEqual(c.received, 1);
    });
});

describe('🧮 composeGuideAggregates() — conservação de sessão', () => {
    const s = (phase, value) => ({ phase, value });

    it('INVARIANTE: sessions.total === soma dos 4 contadores de fase', () => {
        const agg = composeGuideAggregates([
            s(SessionPhase.PENDING_BILLING, 180),
            s(SessionPhase.PENDING_BILLING, 180),
            s(SessionPhase.PENDING_BILLING, 180),
            s(SessionPhase.DOCUMENTATION_SENT, 180),
            s(SessionPhase.DOCUMENTATION_SENT, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.RECEIVED, 180)
        ]);

        const soma = agg.sessions.pendingBilling + agg.sessions.documentationSent
            + agg.sessions.billed + agg.sessions.received;

        assert.strictEqual(agg.sessions.total, 10);
        assert.strictEqual(agg.sessions.total, soma);
    });

    it('estado misto: cada fase mantém seu próprio contador e sua própria soma', () => {
        const agg = composeGuideAggregates([
            s(SessionPhase.PENDING_BILLING, 180),
            s(SessionPhase.PENDING_BILLING, 180),
            s(SessionPhase.PENDING_BILLING, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.BILLED, 180),
            s(SessionPhase.RECEIVED, 180)
        ]);

        assert.deepStrictEqual(
            {
                p: agg.sessions.pendingBilling,
                b: agg.sessions.billed,
                r: agg.sessions.received
            },
            { p: 3, b: 4, r: 1 }
        );
        assert.strictEqual(agg.financialSummary.pendingAmount, 540);
        assert.strictEqual(agg.financialSummary.billedAmount, 720);
        assert.strictEqual(agg.financialSummary.receivedAmount, 180);
        assert.strictEqual(agg.financialSummary.totalAmount, 1440);
    });

    it('sessão fora do ciclo entra em outOfCycle e NÃO infla total nem valor', () => {
        const agg = composeGuideAggregates([
            s(SessionPhase.BILLED, 100),
            s(null, 0),
            s(null, 0)
        ]);
        assert.strictEqual(agg.sessions.total, 1);
        assert.strictEqual(agg.sessions.outOfCycle, 2);
        assert.strictEqual(agg.financialSummary.totalAmount, 100);
    });

    it('guia sem nenhuma sessão => tudo zero, sem quebrar', () => {
        const agg = composeGuideAggregates([]);
        assert.strictEqual(agg.sessions.total, 0);
        assert.strictEqual(agg.financialSummary.totalAmount, 0);
    });
});

describe('🗂️ Buckets das abas — guia mista participa de várias sem duplicar valor', () => {
    // Caso do enunciado da Fase 4: guia de 16 sessões concluídas,
    // 4 a faturar (R$ 560) + 8 faturadas (R$ 1.120) + 4 recebidas (R$ 560).
    const VALOR = 140;
    const guiaMista = [
        ...Array(4).fill(null).map(() => ({ phase: SessionPhase.PENDING_BILLING, value: VALOR })),
        ...Array(8).fill(null).map(() => ({ phase: SessionPhase.BILLED, value: VALOR })),
        ...Array(4).fill(null).map(() => ({ phase: SessionPhase.RECEIVED, value: VALOR }))
    ];

    /** Recorte de uma aba: só as sessões daquela fase — é o que o backend devolve por bucket. */
    const bucket = (sessions, phase) => composeGuideAggregates(sessions.filter(s => s.phase === phase));

    it('a guia entra nas 3 abas em que tem conteúdo', () => {
        const presenca = [
            SessionPhase.PENDING_BILLING,
            SessionPhase.DOCUMENTATION_SENT,
            SessionPhase.BILLED,
            SessionPhase.RECEIVED
        ].filter(p => bucket(guiaMista, p).sessions.total > 0);

        assert.deepStrictEqual(presenca, [
            SessionPhase.PENDING_BILLING,
            SessionPhase.BILLED,
            SessionPhase.RECEIVED
        ]);
    });

    it('cada aba mostra SOMENTE a sua parcela, nunca o total da guia', () => {
        const aFaturar = bucket(guiaMista, SessionPhase.PENDING_BILLING);
        const faturados = bucket(guiaMista, SessionPhase.BILLED);
        const recebidos = bucket(guiaMista, SessionPhase.RECEIVED);

        assert.strictEqual(aFaturar.sessions.total, 4);
        assert.strictEqual(aFaturar.financialSummary.pendingAmount, 560);

        assert.strictEqual(faturados.sessions.total, 8);
        assert.strictEqual(faturados.financialSummary.billedAmount, 1120);

        assert.strictEqual(recebidos.sessions.total, 4);
        assert.strictEqual(recebidos.financialSummary.receivedAmount, 560);

        // nenhuma aba exibe o total da guia (R$ 2.240)
        const total = composeGuideAggregates(guiaMista).financialSummary.totalAmount;
        assert.strictEqual(total, 2240);
        for (const b of [aFaturar, faturados, recebidos]) {
            assert.notStrictEqual(b.financialSummary.totalAmount, total);
        }
    });

    it('ANTI-DUPLA-CONTAGEM: somar as 3 abas reproduz o total exatamente uma vez', () => {
        const soma =
            bucket(guiaMista, SessionPhase.PENDING_BILLING).financialSummary.totalAmount +
            bucket(guiaMista, SessionPhase.DOCUMENTATION_SENT).financialSummary.totalAmount +
            bucket(guiaMista, SessionPhase.BILLED).financialSummary.totalAmount +
            bucket(guiaMista, SessionPhase.RECEIVED).financialSummary.totalAmount;

        assert.strictEqual(soma, composeGuideAggregates(guiaMista).financialSummary.totalAmount);

        const somaSessoes =
            bucket(guiaMista, SessionPhase.PENDING_BILLING).sessions.total +
            bucket(guiaMista, SessionPhase.DOCUMENTATION_SENT).sessions.total +
            bucket(guiaMista, SessionPhase.BILLED).sessions.total +
            bucket(guiaMista, SessionPhase.RECEIVED).sessions.total;

        assert.strictEqual(somaSessoes, 16);
    });

    it('Faturados + Recebidos simultâneos: guia sem pendência entra nas duas abas', () => {
        const guia = [
            ...Array(3).fill(null).map(() => ({ phase: SessionPhase.BILLED, value: 100 })),
            ...Array(2).fill(null).map(() => ({ phase: SessionPhase.RECEIVED, value: 100 }))
        ];
        assert.strictEqual(bucket(guia, SessionPhase.BILLED).sessions.total, 3);
        assert.strictEqual(bucket(guia, SessionPhase.RECEIVED).sessions.total, 2);
        assert.strictEqual(bucket(guia, SessionPhase.PENDING_BILLING).sessions.total, 0);
        // rótulo é a fase menos avançada presente, mas não impede a guia de estar nas duas abas
        assert.strictEqual(
            deriveBillingLabel({ pendingBilling: 0, documentationSent: 0, billed: 3, received: 2 }),
            GuideBillingLabel.BILLED
        );
    });

    it('sessão não concluída não entra em bucket nenhum', () => {
        const guia = [...guiaMista, { phase: null, value: 0 }, { phase: null, value: 0 }];
        const somaSessoes = PHASES.reduce((acc, p) => acc + bucket(guia, p).sessions.total, 0);
        assert.strictEqual(somaSessoes, 16);
        assert.strictEqual(composeGuideAggregates(guia).sessions.outOfCycle, 2);
    });
});

describe('📅 competenceDateFor() — cada fase tem seu eixo de data', () => {
    const session = { date: new Date('2026-05-10') };
    const payment = {
        insurance: {
            billedAt: new Date('2026-06-02'),
            receivedAt: new Date('2026-07-15')
        }
    };
    const documentationSentAt = new Date('2026-05-28');

    it('pendingBilling usa Session.date', () => {
        assert.strictEqual(
            competenceDateFor(SessionPhase.PENDING_BILLING, { session, payment, documentationSentAt }).toISOString(),
            session.date.toISOString()
        );
    });

    it('documentationSent usa a data de envio da comunicação', () => {
        assert.strictEqual(
            competenceDateFor(SessionPhase.DOCUMENTATION_SENT, { session, payment, documentationSentAt }).toISOString(),
            documentationSentAt.toISOString()
        );
    });

    it('billed usa Payment.insurance.billedAt', () => {
        assert.strictEqual(
            competenceDateFor(SessionPhase.BILLED, { session, payment, documentationSentAt }).toISOString(),
            payment.insurance.billedAt.toISOString()
        );
    });

    it('received usa Payment.insurance.receivedAt', () => {
        assert.strictEqual(
            competenceDateFor(SessionPhase.RECEIVED, { session, payment, documentationSentAt }).toISOString(),
            payment.insurance.receivedAt.toISOString()
        );
    });

    it('REGRESSÃO: um único campo de data não serve — os 4 eixos divergem', () => {
        const datas = [
            SessionPhase.PENDING_BILLING,
            SessionPhase.DOCUMENTATION_SENT,
            SessionPhase.BILLED,
            SessionPhase.RECEIVED
        ].map(p => competenceDateFor(p, { session, payment, documentationSentAt }).toISOString());

        assert.strictEqual(new Set(datas).size, 4, 'as 4 fases devem cair em meses/datas distintos');
    });
});

describe('📆 composePendingCompetenceBreakdown() — backlog por guia', () => {
    const referenceDate = new Date('2026-08-07T12:00:00.000Z');

    it('separa mês atual e anteriores usando Session.date', () => {
        const result = composePendingCompetenceBreakdown([
            { phase: SessionPhase.PENDING_BILLING, date: '2026-08-02', value: 140 },
            { phase: SessionPhase.PENDING_BILLING, date: '2026-07-30', value: 120 },
            { phase: SessionPhase.PENDING_BILLING, date: '2026-05-10', value: 100 }
        ], referenceDate);

        assert.deepStrictEqual(result, {
            referenceMonth: '2026-08',
            current: { value: 140, sessions: 1 },
            previous: { value: 220, sessions: 2, oldestCompetence: '2026-05' }
        });
    });

    it('não mistura documentationSent, billed, received nem sessão futura', () => {
        const result = composePendingCompetenceBreakdown([
            { phase: SessionPhase.DOCUMENTATION_SENT, date: '2026-06-01', value: 100 },
            { phase: SessionPhase.BILLED, date: '2026-05-01', value: 200 },
            { phase: SessionPhase.RECEIVED, date: '2026-04-01', value: 300 },
            { phase: SessionPhase.PENDING_BILLING, date: '2026-09-01', value: 400 }
        ], referenceDate);

        assert.deepStrictEqual(result.previous, {
            value: 0, sessions: 0, oldestCompetence: null
        });
        assert.deepStrictEqual(result.current, { value: 0, sessions: 0 });
    });

    it('arredonda valores financeiros sem perder a quantidade de sessões', () => {
        const result = composePendingCompetenceBreakdown([
            { phase: SessionPhase.PENDING_BILLING, date: '2026-07-01', value: 10.005 },
            { phase: SessionPhase.PENDING_BILLING, date: '2026-07-02', value: 20.004 }
        ], referenceDate);

        assert.deepStrictEqual(result.previous, {
            value: 30.01, sessions: 2, oldestCompetence: '2026-07'
        });
    });
});

describe('💰 resolveSessionValue() — Payment é SSOT, sessão/guia só fallback', () => {
    it('prefere insurance.grossAmount do Payment', () => {
        assert.strictEqual(
            resolveSessionValue({ sessionValue: 999 }, { insurance: { grossAmount: 180 }, amount: 500 }, { sessionValue: 777 }),
            180
        );
    });

    it('sem grossAmount, cai para Payment.amount', () => {
        assert.strictEqual(
            resolveSessionValue({ sessionValue: 999 }, { amount: 150, insurance: {} }, { sessionValue: 777 }),
            150
        );
    });

    it('sem Payment, usa Session.sessionValue (dado antigo)', () => {
        assert.strictEqual(resolveSessionValue({ sessionValue: 120 }, null, { sessionValue: 777 }), 120);
    });

    it('sem Payment e sem sessionValue na sessão, cai para a guia', () => {
        assert.strictEqual(resolveSessionValue({}, null, { sessionValue: 90 }), 90);
    });

    it('nada disponível => 0, nunca NaN', () => {
        assert.strictEqual(resolveSessionValue({}, null, {}), 0);
    });
});

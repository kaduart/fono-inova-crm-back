/**
 * Testes de regressão para calculateMetaRealizada (unifiedFinancialService.v2.js).
 *
 * Regra (back/docs/FINANCIAL_SOURCE_OF_TRUTH.md → "Meta Realizada"): Meta
 * Realizada = Caixa Real MENOS convênio de competência anterior (retroativo)
 * MENOS Liminar. Venda de pacote conta integralmente quando paga, mesmo
 * cobrindo sessões futuras. Calculado direto dos Payments do caixa — nunca
 * por resíduo (caixa − produção).
 *
 * Cenários fictícios (sem dados reais de paciente), mês de referência
 * setembro/2026:
 *   - pacote parcialmente pré-consumido: 2 sessões pagas avulsas antes do
 *     pacote existir (R$150 cada) + pacote de 12 sessões restantes (R$1.800)
 *     = R$2.100.
 *   - convênio retroativo: 10 sessões de jun-ago/2026, recebidas em lote em
 *     02/09/2026 (R$1.800) — fora da meta.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { calculateMetaRealizada, invalidateUFSCache } from '../unifiedFinancialService.v2.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import { transitionPaymentStatus } from '../paymentStatusService.js';

let mongoServer;
let db;

const MONTH_START = new Date('2026-09-01T03:00:00.000Z'); // 00:00 America/Sao_Paulo (01/09)
// BUG anterior: 2026-09-30T02:59:59.999Z é 29/09 23:59:59 BRT — um dia antes
// do fim real do mês. Setembro só termina às 23:59:59 BRT do dia 30, que em
// UTC (America/Sao_Paulo = UTC-3, sem horário de verão) é 01/10 02:59:59.999.
const MONTH_END = new Date('2026-10-01T02:59:59.999Z');   // 23:59:59 America/Sao_Paulo (30/09)

beforeAll(async () => {
    // ReplSet de 1 nó (não MongoMemoryServer standalone): o teste de estorno
    // exercita transitionPaymentStatus() saindo de 'paid', que abre uma
    // transação Mongo real (reversão de ledger) — MongoDB só permite
    // transações em replica set/mongos.
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());
    db = mongoose.connection.db;
}, 30000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await db.collection('payments').deleteMany({});
    await db.collection('appointments').deleteMany({});
    // calculateMetaRealizada NÃO tem cache próprio (decisão 2026-09-03, ver
    // unifiedFinancialService.v2.js) — chamada aqui só por higiene, pra não
    // vazar cache de calculateCash/calculateProduction (que usam o mesmo Map)
    // entre testes que rodem os dois no mesmo arquivo.
    invalidateUFSCache();
});

function basePayment(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        status: 'paid',
        amount: 100,
        kind: 'session_payment',
        billingType: 'particular',
        isFromPackage: false,
        financialDate: new Date('2026-09-05T12:00:00.000Z'),
        paymentDate: new Date('2026-09-05T12:00:00.000Z'),
        serviceDate: new Date('2026-09-05T12:00:00.000Z'),
        ...overrides
    };
}

describe('calculateMetaRealizada — cenários auditados (fixtures fictícias)', () => {
    it('pacote parcialmente pré-consumido: 2 sessões avulsas pré-pacote (R$150 cada) + pacote das 12 restantes (R$1.800) = R$2.100 incluídos', async () => {
        const packageId = new mongoose.Types.ObjectId();
        await db.collection('payments').insertMany([
            basePayment({
                amount: 150, kind: 'session_payment', billingType: 'particular',
                package: packageId, serviceDate: new Date('2026-09-01T12:00:00.000Z')
            }),
            basePayment({
                amount: 150, kind: 'session_payment', billingType: 'particular',
                package: packageId, serviceDate: new Date('2026-09-02T12:00:00.000Z')
            }),
            basePayment({
                amount: 1800, kind: 'package_receipt', billingType: 'particular',
                package: packageId, serviceDate: null
            }),
        ]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(2100);
        expect(result.porTipo.pacote).toBe(2100);
        expect(result.excluded.retroativoConvenio).toBe(0);
    });

    it('convênio retroativo: R$1.800 (10 sessões jun-ago) recebido em setembro é excluído', async () => {
        const julySessions = Array.from({ length: 9 }, (_, i) =>
            basePayment({
                amount: 180, kind: 'session_payment', billingType: 'convenio',
                financialDate: new Date('2026-09-02T03:00:00.000Z'),
                paymentDate: new Date(`2026-07-0${(i % 9) + 1}T12:00:00.000Z`),
                serviceDate: new Date(`2026-07-0${(i % 9) + 1}T12:00:00.000Z`),
            })
        );
        const augSession = basePayment({
            amount: 180, kind: 'session_payment', billingType: 'convenio',
            financialDate: new Date('2026-09-02T03:00:00.000Z'),
            paymentDate: new Date('2026-08-05T12:00:00.000Z'),
            serviceDate: new Date('2026-08-05T12:00:00.000Z'),
        });
        await db.collection('payments').insertMany([...julySessions, augSession]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(0);
        expect(result.porTipo.convenio).toBe(0);
        expect(result.excluded.retroativoConvenio).toBe(1800);
    });

    it('convênio com sessão realizada E recebida no mesmo mês entra na meta', async () => {
        await db.collection('payments').insertOne(
            basePayment({
                amount: 220, kind: 'session_payment', billingType: 'convenio',
                serviceDate: new Date('2026-09-10T12:00:00.000Z'),
                financialDate: new Date('2026-09-12T12:00:00.000Z'),
            })
        );

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(220);
        expect(result.porTipo.convenio).toBe(220);
        expect(result.excluded.retroativoConvenio).toBe(0);
    });

    it('NF mista (mesmo lote, sessões de competência anterior E do mês atual) exclui só a sessão antiga', async () => {
        const batchId = new mongoose.Types.ObjectId();
        await db.collection('payments').insertMany([
            basePayment({
                amount: 180, kind: 'session_payment', billingType: 'convenio',
                billingBatchId: batchId,
                serviceDate: new Date('2026-08-20T12:00:00.000Z'), // competência anterior
                financialDate: new Date('2026-09-03T12:00:00.000Z'),
            }),
            basePayment({
                amount: 180, kind: 'session_payment', billingType: 'convenio',
                billingBatchId: batchId,
                serviceDate: new Date('2026-09-01T12:00:00.000Z'), // competência atual
                financialDate: new Date('2026-09-03T12:00:00.000Z'),
            }),
        ]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        // Só a sessão de 01/09 entra; a de 20/08 (mesma NF) fica de fora.
        expect(result.total).toBe(180);
        expect(result.porTipo.convenio).toBe(180);
        expect(result.excluded.retroativoConvenio).toBe(180);
    });

    it('convênio sem serviceDate resolve competência via appointment.date (fonte canônica) — exclui como retroativo, não assume mês atual', async () => {
        const apptId = new mongoose.Types.ObjectId();
        await db.collection('appointments').insertOne({
            _id: apptId,
            date: new Date('2026-08-15T12:00:00.000Z'), // competência anterior ao mês
        });
        await db.collection('payments').insertOne(
            basePayment({
                amount: 210, kind: 'session_payment', billingType: 'convenio',
                serviceDate: null, appointment: apptId,
                financialDate: new Date('2026-09-03T12:00:00.000Z'),
            })
        );

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(0);
        expect(result.excluded.retroativoConvenio).toBe(210);
        expect(result.excluded.semCompetencia).toBe(0);
    });

    it('convênio sem serviceDate, appointment ou session: sem evidência de competência, exclui explicitamente (não conta como mês atual por omissão)', async () => {
        await db.collection('payments').insertOne(
            basePayment({
                amount: 175, kind: 'session_payment', billingType: 'convenio',
                serviceDate: null, appointment: null, session: null,
                financialDate: new Date('2026-09-03T12:00:00.000Z'),
            })
        );

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(0);
        expect(result.porTipo.convenio).toBe(0);
        expect(result.excluded.retroativoConvenio).toBe(0);
        expect(result.excluded.semCompetencia).toBe(175);
        expect(result.count.examined).toBe(1);
        expect(result.count.included).toBe(0);
    });

    it('convênio do mês atual ainda pendente (status != paid) não aparece — nem incluído nem excluído', async () => {
        await db.collection('payments').insertOne(
            basePayment({
                status: 'pending', amount: 300, kind: 'session_payment', billingType: 'convenio',
                serviceDate: new Date('2026-09-10T12:00:00.000Z'),
            })
        );

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(0);
        expect(result.count.examined).toBe(0);
        expect(result.count.included).toBe(0);
    });

    it('Liminar é excluído mesmo com sessão do mês atual e já pago', async () => {
        await db.collection('payments').insertOne(
            basePayment({
                amount: 630, kind: 'session_payment', billingType: 'liminar',
                serviceDate: new Date('2026-09-05T12:00:00.000Z'),
            })
        );

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(0);
        expect(result.porTipo.liminar).toBe(0);
        expect(result.excluded.liminar).toBe(630);
    });

    it('Meta = soma exata de porTipo (particular + pacote + convenio + liminar)', async () => {
        await db.collection('payments').insertMany([
            basePayment({ amount: 200, kind: 'session_payment', billingType: 'particular' }),
            basePayment({ amount: 400, kind: 'package_receipt', billingType: 'particular', package: new mongoose.Types.ObjectId() }),
            basePayment({ amount: 150, kind: 'session_payment', billingType: 'convenio', serviceDate: new Date('2026-09-10T12:00:00.000Z') }),
            basePayment({ amount: 630, kind: 'session_payment', billingType: 'liminar' }),
        ]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        const somaPorTipo = result.porTipo.particular + result.porTipo.pacote + result.porTipo.convenio + result.porTipo.liminar;
        expect(somaPorTipo).toBe(result.total);
        expect(result.total).toBe(750); // 200 + 400 + 150 (liminar excluído)
    });

    it('cenário composto: fecha exatamente em R$6.880 (particular avulso + pacote pré-consumido + vendas de pacote + convênio retroativo)', async () => {
        const pacotePreConsumidoId = new mongoose.Types.ObjectId();
        const pacoteBId = new mongoose.Types.ObjectId();
        const pacoteCId = new mongoose.Types.ObjectId();
        const pacoteDId = new mongoose.Types.ObjectId();
        const pacoteEId = new mongoose.Types.ObjectId();

        const particularAvulso = [140, 250, 220, 180, 140, 200, 180, 180, 200, 250, 200, 200] // Grupo A = 2.340
            .map(amount => basePayment({ amount, billingType: 'particular' }));

        const sessoesPreConsumidas = [
            basePayment({ amount: 150, billingType: 'particular', package: pacotePreConsumidoId, serviceDate: new Date('2026-09-01T12:00:00.000Z') }),
            basePayment({ amount: 150, billingType: 'particular', package: pacotePreConsumidoId, serviceDate: new Date('2026-09-02T12:00:00.000Z') }),
        ]; // Grupo B = 300

        const vendasPacote = [
            basePayment({ amount: 1800, kind: 'package_receipt', billingType: 'particular', package: pacotePreConsumidoId, serviceDate: null }),
            basePayment({ amount: 720, kind: 'package_receipt', billingType: 'particular', package: pacoteBId, serviceDate: null }),
            basePayment({ amount: 720, kind: 'package_receipt', billingType: 'particular', package: pacoteCId, serviceDate: null }),
            basePayment({ amount: 800, kind: 'package_receipt', billingType: 'particular', package: pacoteDId, serviceDate: null }),
            basePayment({ amount: 200, kind: 'package_receipt', billingType: 'particular', package: pacoteEId, serviceDate: null }),
        ]; // Grupo C = 4.240

        const convenioRetroativo = Array.from({ length: 10 }, () =>
            basePayment({
                amount: 180, billingType: 'convenio',
                financialDate: new Date('2026-09-02T03:00:00.000Z'),
                serviceDate: new Date('2026-07-15T12:00:00.000Z'), // sempre antes do mês
            })
        ); // Grupo D = 1.800, excluído

        await db.collection('payments').insertMany([
            ...particularAvulso, ...sessoesPreConsumidas, ...vendasPacote, ...convenioRetroativo
        ]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(6880);
        expect(result.excluded.retroativoConvenio).toBe(1800);
        const somaPorTipo = result.porTipo.particular + result.porTipo.pacote + result.porTipo.convenio + result.porTipo.liminar;
        expect(somaPorTipo).toBe(6880);
    });

    it('respeita o fuso de Anápolis (America/Sao_Paulo) no início do mês — 31/08 23:59 BRT fica fora, 01/09 00:00 BRT entra', async () => {
        await db.collection('payments').insertMany([
            // 31/08 23:59 America/Sao_Paulo = 01/09 02:59 UTC — antes de MONTH_START (01/09 03:00 UTC)
            basePayment({ amount: 999, financialDate: new Date('2026-09-01T02:59:00.000Z'), paymentDate: new Date('2026-09-01T02:59:00.000Z') }),
            // 01/09 00:00 America/Sao_Paulo = 01/09 03:00 UTC — exatamente o início do mês
            basePayment({ amount: 111, financialDate: new Date('2026-09-01T03:00:00.000Z'), paymentDate: new Date('2026-09-01T03:00:00.000Z') }),
        ]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(111);
    });

    it('respeita o fuso de Anápolis (America/Sao_Paulo) no fim do mês — 30/09 23:59:59 BRT entra, 01/10 00:00 BRT fica fora', async () => {
        await db.collection('payments').insertMany([
            // 30/09 23:59:59 America/Sao_Paulo = 01/10 02:59:59.999 UTC — exatamente o fim do mês (MONTH_END)
            basePayment({ amount: 222, financialDate: new Date('2026-10-01T02:59:59.999Z'), paymentDate: new Date('2026-10-01T02:59:59.999Z') }),
            // 01/10 00:00 America/Sao_Paulo = 01/10 03:00 UTC — já é outubro, fora do mês
            basePayment({ amount: 888, financialDate: new Date('2026-10-01T03:00:00.000Z'), paymentDate: new Date('2026-10-01T03:00:00.000Z') }),
        ]);

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(222);
    });
});

describe('calculateMetaRealizada — sem cache próprio, todo write path reflete imediatamente', () => {
    // 🚨 DECISÃO (2026-09-03, revisada): calculateMetaRealizada NÃO usa
    // _ufsCache (ao contrário de calculateCash/calculateProduction). A
    // primeira versão desta função cacheava e invalidava via hooks em
    // models/Payment.js (post('save')/post('findOneAndDelete'|...)) — mas
    // isso (a) criava um ciclo de import Payment.js → unifiedFinancialService
    // .v2.js → Payment.js (model de domínio não deve depender de serviço de
    // dashboard) e (b) a auditoria de cobertura achou caminhos reais que não
    // passam por hook nenhum de documento: Payment.bulkWrite (usado por
    // transitionPaymentStatusBatchToReceived, o recebimento em lote de
    // convênio) dispara hooks de query 'bulkWrite'? NÃO — bulkWrite não roda
    // middleware de documento nem findOneAndUpdate; e o worker de pagamento
    // roda em processo separado, então mesmo um hook completo no model não
    // ajudaria (cache era um Map em memória de UM processo).
    //
    // A troca: como a query mede ~33ms de mediana (ver describe "custo real"
    // abaixo) e não há mais nenhuma outra função neste arquivo que já carregue
    // os Payments do período (calculateCash usa aggregation, nunca traz os
    // docs pro Node — ver auditoria de reuso), calculateMetaRealizada sempre
    // calcula fresco. Isso resolve por construção qualquer write path,
    // presente ou futuro, e qualquer processo (não há estado compartilhado
    // pra ficar stale) — os testes abaixo provam isso para cada verbo exigido.
    afterEach(async () => {
        await Payment.deleteMany({});
    });

    it('criação: novo Payment paid dentro do mês entra na meta sem esperar o TTL', async () => {
        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(0);

        await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 300,
            paymentDate: new Date('2026-09-10T12:00:00.000Z'),
            paidAt: new Date('2026-09-10T12:00:00.000Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'paid',
            kind: 'session_payment',
        });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(300);
    });

    it('recebimento: transição pending → paid via transitionPaymentStatus entra na meta sem esperar o TTL', async () => {
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 400,
            paymentDate: new Date('2026-09-10T12:00:00.000Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'pending',
            kind: 'session_payment',
        });

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(0);

        await transitionPaymentStatus(payment._id.toString(), 'paid', {
            silent: true,
            paidAt: new Date('2026-09-10T12:00:00.000Z'),
            financialDate: new Date('2026-09-10T12:00:00.000Z'),
        });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(400);
    });

    it('estorno: transição paid → pending via transitionPaymentStatus sai da meta sem esperar o TTL', async () => {
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 500,
            paymentDate: new Date('2026-09-10T12:00:00.000Z'),
            financialDate: new Date('2026-09-10T12:00:00.000Z'),
            paidAt: new Date('2026-09-10T12:00:00.000Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'paid',
            kind: 'session_payment',
        });

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(500);

        await transitionPaymentStatus(payment._id.toString(), 'pending', { silent: true });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(0);
    });

    it('alteração: mudança de valor em Payment paid existente reflete na meta sem esperar o TTL', async () => {
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 100,
            paymentDate: new Date('2026-09-10T12:00:00.000Z'),
            financialDate: new Date('2026-09-10T12:00:00.000Z'),
            paidAt: new Date('2026-09-10T12:00:00.000Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'paid',
            kind: 'session_payment',
        });

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(100);

        payment.amount = 900;
        await payment.save();

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(900);
    });

    it('exclusão (deleteOne via findByIdAndDelete): Payment paid some da meta sem esperar o TTL', async () => {
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 250,
            paymentDate: new Date('2026-09-10T12:00:00.000Z'),
            financialDate: new Date('2026-09-10T12:00:00.000Z'),
            paidAt: new Date('2026-09-10T12:00:00.000Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'paid',
            kind: 'session_payment',
        });

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(250);

        await Payment.findByIdAndDelete(payment._id);

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(0);
    });

    it('findOneAndUpdate: mudar amount por query (sem carregar/save() o documento) reflete na meta', async () => {
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 120,
            paymentDate: new Date('2026-09-10T12:00:00.000Z'),
            financialDate: new Date('2026-09-10T12:00:00.000Z'),
            paidAt: new Date('2026-09-10T12:00:00.000Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'paid',
            kind: 'session_payment',
        });

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(120);

        await Payment.findOneAndUpdate({ _id: payment._id }, { $set: { amount: 640 } });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(640);
    });

    it('updateMany: recebimento em massa por query (ex: correção administrativa) reflete na meta', async () => {
        const ids = [];
        for (const amount of [80, 90, 100]) {
            const p = await Payment.create({
                patient: new mongoose.Types.ObjectId(), amount,
                paymentDate: new Date('2026-09-10T12:00:00.000Z'),
                paymentMethod: 'pix', billingType: 'particular', status: 'pending', kind: 'session_payment',
            });
            ids.push(p._id);
        }

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(0); // todos pending

        await Payment.updateMany(
            { _id: { $in: ids } },
            { $set: { status: 'paid', paidAt: new Date('2026-09-10T12:00:00.000Z'), financialDate: new Date('2026-09-10T12:00:00.000Z') } }
        );

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(270); // 80+90+100
    });

    it('deleteMany: remoção em massa por query reflete na meta', async () => {
        for (const amount of [50, 60]) {
            await Payment.create({
                patient: new mongoose.Types.ObjectId(), amount,
                paymentDate: new Date('2026-09-10T12:00:00.000Z'), financialDate: new Date('2026-09-10T12:00:00.000Z'),
                paidAt: new Date('2026-09-10T12:00:00.000Z'),
                paymentMethod: 'pix', billingType: 'particular', status: 'paid', kind: 'session_payment',
            });
        }

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(110);

        await Payment.deleteMany({ billingType: 'particular', amount: { $in: [50, 60] } });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(0);
    });

    it('bulkWrite: mesmo mecanismo usado por transitionPaymentStatusBatchToReceived (recebimento em lote de convênio) reflete na meta', async () => {
        const ids = [];
        for (let i = 0; i < 3; i++) {
            const p = await Payment.create({
                patient: new mongoose.Types.ObjectId(), amount: 180,
                paymentDate: new Date('2026-09-10T12:00:00.000Z'),
                paymentMethod: 'convenio', billingType: 'convenio', status: 'billed', kind: 'session_payment',
                serviceDate: new Date('2026-09-05T12:00:00.000Z'),
            });
            ids.push(p._id);
        }

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(0); // 'billed', ainda não recebido

        await Payment.bulkWrite(ids.map(_id => ({
            updateOne: {
                filter: { _id },
                update: { $set: {
                    status: 'paid',
                    paidAt: new Date('2026-09-10T12:00:00.000Z'),
                    financialDate: new Date('2026-09-10T12:00:00.000Z'),
                    'insurance.status': 'received',
                } }
            }
        })), { ordered: true });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(540); // 3 x 180
        expect(after.porTipo.convenio).toBe(540);
    });

    it('insertMany: criação em lote (ex: importação/migração) reflete na meta', async () => {
        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(0);

        await Payment.insertMany([
            { patient: new mongoose.Types.ObjectId(), amount: 70, paymentDate: new Date('2026-09-10T12:00:00.000Z'), financialDate: new Date('2026-09-10T12:00:00.000Z'), paidAt: new Date('2026-09-10T12:00:00.000Z'), paymentMethod: 'pix', billingType: 'particular', status: 'paid', kind: 'session_payment' },
            { patient: new mongoose.Types.ObjectId(), amount: 30, paymentDate: new Date('2026-09-10T12:00:00.000Z'), financialDate: new Date('2026-09-10T12:00:00.000Z'), paidAt: new Date('2026-09-10T12:00:00.000Z'), paymentMethod: 'pix', billingType: 'particular', status: 'paid', kind: 'session_payment' },
        ]);

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBe(100);
    });

    // "escrita em processo separado" (worker): não há como um cache em memória
    // de UM processo Node saber de uma escrita feita por outro — é exatamente
    // por isso que este arquivo não mantém cache (ver comentário do describe).
    // Como calculateMetaRealizada nunca lê de um Map compartilhado, uma
    // escrita do worker (workers/paymentWorker.js, outro processo) e uma
    // escrita bulkWrite (teste acima, mesmo mecanismo Mongo) são
    // indistinguíveis pra esta função: ambas só existem via uma nova consulta
    // ao MongoDB, que é sempre a fonte. O teste de integração dedicado
    // (tests/integration/insuranceBatchReceive.cacheInvalidation.integration.test.js)
    // prova isso fim-a-fim com o fluxo real de recebimento em lote de convênio,
    // incluindo o cache Redis do endpoint de cashflow (camada onde staleness
    // entre processos de fato poderia acontecer, e onde a correção real deste
    // ciclo estava: routes/cashflow.v2.js#clearCashflowCache).
});

describe('calculateMetaRealizada — custo real e ausência de N+1', () => {
    afterEach(async () => {
        await Payment.deleteMany({});
        await Appointment.deleteMany({});
        await Session.deleteMany({});
        vi.restoreAllMocks();
    });

    // 📊 Números reais medidos contra produção (Atlas, 2026-09-03, 31 Payments
    // no período, mesma query desta suite):
    //   - explain('executionStats').executionTimeMillis = 33ms (server-side,
    //     tempo que o Mongo gasta plan+execute — não inclui rede/driver).
    //   - calculateMetaRealizada isolada em processo recém-iniciado: 738-1000ms.
    //   - 25 chamadas na MESMA conexão mongoose (loop): [1000, 805, 681, 181,
    //     106, 80, 128, 47, 38, 26, 24, 25, 33, 25, 61, 96, 37, 26, 26, 33, 23,
    //     25, 29, 28, 27] → median=33ms, p95=805ms (calculado sobre as 25);
    //     excluindo só a 1ª chamada, median=33ms, p95=681ms.
    // A queda de 1000ms→~25-30ms ao longo das primeiras ~10 chamadas é o
    // connection pool do driver mongodb+srv abrindo e aquecendo sockets TLS
    // pro Atlas (fora da rede da AWS, cada socket novo paga handshake
    // completo) — não é custo por chamada da query em si. No processo real do
    // backend (Render, long-lived, pool já quente), toda chamada já entra no
    // regime de ~25-40ms — os 738ms só apareceram porque os scripts de
    // verificação usados durante esta auditoria abriam uma conexão nova a
    // cada execução. A mediana de 33ms bate quase exatamente com o
    // executionTimeMillis do explain(), confirmando que praticamente todo o
    // tempo em regime quente é a própria query MongoDB, não overhead do
    // Node/Mongoose.
    it('não existe N+1 no fallback de competência: N payments sem serviceDate geram no máximo 1 query em Appointment e 1 em Session, não N', async () => {
        const N = 6;
        const apptIds = [];
        for (let i = 0; i < N; i++) {
            const apptId = new mongoose.Types.ObjectId();
            await Appointment.collection.insertOne({ _id: apptId, date: new Date('2026-09-05T12:00:00.000Z') });
            apptIds.push(apptId);
            await Payment.create({
                patient: new mongoose.Types.ObjectId(), amount: 100,
                paymentDate: new Date('2026-09-05T12:00:00.000Z'), financialDate: new Date('2026-09-05T12:00:00.000Z'),
                paidAt: new Date('2026-09-05T12:00:00.000Z'), paymentMethod: 'convenio', billingType: 'convenio',
                status: 'paid', kind: 'session_payment', appointment: apptId, serviceDate: null,
            });
        }

        const apptFindSpy = vi.spyOn(Appointment, 'find');
        const sessFindSpy = vi.spyOn(Session, 'find');

        const result = await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(result.total).toBe(N * 100);
        expect(apptFindSpy).toHaveBeenCalledTimes(1); // 1 query com $in, não N
        // Session.find só roda se sobrar algum payment sem appointment resolvido — aqui todos resolveram por appointment, então 0 é esperado.
        expect(sessFindSpy.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('sem convênio faltando serviceDate no período, a consulta de competência (Appointment/Session) não dispara — zero overhead', async () => {
        await Payment.create({
            patient: new mongoose.Types.ObjectId(), amount: 500,
            paymentDate: new Date('2026-09-05T12:00:00.000Z'), financialDate: new Date('2026-09-05T12:00:00.000Z'),
            paidAt: new Date('2026-09-05T12:00:00.000Z'), paymentMethod: 'pix', billingType: 'particular',
            status: 'paid', kind: 'session_payment',
        });

        const apptFindSpy = vi.spyOn(Appointment, 'find');
        const sessFindSpy = vi.spyOn(Session, 'find');

        await calculateMetaRealizada(MONTH_START, MONTH_END);

        expect(apptFindSpy).not.toHaveBeenCalled();
        expect(sessFindSpy).not.toHaveBeenCalled();
    });
});

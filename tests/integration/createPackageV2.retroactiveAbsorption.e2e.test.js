/**
 * 🧪 Aceitação end-to-end: criação de pacote (POST /api/v2/packages via
 * createPackageV2) absorvendo 1 sessão retroativa selecionada, com histórico
 * de PatientBalance legado quebrado no meio do caminho (caso Julia Boarati).
 *
 * `calculationMode` (por mês / por número de sessões) não tem NENHUM branch
 * no backend — grep confirma que `controllers/packageController.v2.js` nunca
 * lê esse campo. O frontend usa o modo só pra decidir COMO calcular o
 * `schedule` antes de enviar; o backend recebe sempre a mesma forma
 * (schedule explícito + totalSessions + preConsumedCount). Por isso o mesmo
 * teste roda parametrizado com os dois valores de `calculationMode` — prova
 * empírica de que os dois modos passam pelo mesmo código no servidor, em vez
 * de duas suítes redundantes testando o mesmo branch inexistente duas vezes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../services/financialGuard/index.js', () => ({
    default: { execute: vi.fn().mockResolvedValue({}) }
}));
vi.mock('../../infrastructure/queue/queueConfig.js', () => ({
    getQueue: () => ({ add: vi.fn() }),
    queues: {},
    redisConnection: { status: 'ready', on: () => {} }
}));

import '../../models/PatientsView.js';
import PatientBalance from '../../models/PatientBalance.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Package from '../../models/Package.js';
import Outbox from '../../infrastructure/outbox/OutboxModel.js';
import { createPackageV2 } from '../../controllers/packageController.v2.js';

describe('E2E: createPackageV2 — absorção retroativa selecionada + ledger legado quebrado', () => {
    let mongoReplSet;
    const DOCTOR_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        mongoReplSet = await MongoMemoryReplSet.create({ replSet: { count: 1, dbName: 'crm_test' } });
        await mongoose.connect(mongoReplSet.getUri());

        await Doctor.create({
            _id: DOCTOR_ID,
            fullName: 'Doutora Teste E2E',
            specialty: 'fonoaudiologia',
            phoneNumber: '11977776666',
            licenseNumber: 'CRM-E2E-1',
            email: 'doctor-e2e@test.com'
        });

        // MongoMemoryReplSet: criar uma coleção pela PRIMEIRA vez DENTRO de
        // uma transação multi-documento causa "catalog changes" — createCollection()
        // sozinho não é suficiente (índices/coleção só materializam de verdade
        // no primeiro documento real). Escreve e apaga um documento descartável
        // em cada coleção tocada por createPackageV2, fora de qualquer transação.
        const dummyId = new mongoose.Types.ObjectId();
        await Package.create({
            _id: dummyId, patient: DOCTOR_ID, doctor: DOCTOR_ID, durationMonths: 1,
            sessionsPerWeek: 1, sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
            date: new Date(), totalSessions: 1, sessionValue: 1, totalValue: 1
        });
        await Package.deleteOne({ _id: dummyId });
        await Outbox.create({ eventId: 'warmup', eventType: 'WARMUP', payload: {}, aggregateType: 'warmup', aggregateId: 'warmup', correlationId: 'warmup' });
        await Outbox.deleteOne({ eventId: 'warmup' });

        // MongoMemoryReplSet: a PRIMEIRA transação multi-documento depois do
        // replset subir tende a esbarrar em "catalog changes" mesmo com as
        // coleções já existindo (artefato de inicialização do replset, não
        // do código da aplicação) — "esquenta" a maquinaria de transação
        // com uma transação descartável antes de qualquer teste real.
        const warmupSession = await mongoose.startSession();
        await warmupSession.startTransaction();
        await Package.updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { updatedAt: new Date() } }, { session: warmupSession });
        await warmupSession.commitTransaction();
        await warmupSession.endSession();
    });

    beforeEach(async () => {
        await Package.deleteMany({});
        await Appointment.deleteMany({});
        await Session.deleteMany({});
        await Payment.deleteMany({});
        await PatientBalance.deleteMany({});
        await Patient.deleteMany({});
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoReplSet.stop();
    });

    async function setupPatientWithRetroactiveSession(suffix) {
        const patientId = new mongoose.Types.ObjectId();
        await Patient.create({
            _id: patientId,
            fullName: `Paciente E2E ${suffix}`,
            dateOfBirth: new Date('1990-01-01'),
            phone: `1199999${suffix}`
        });

        const appointment = new Appointment({
            patient: patientId,
            doctor: DOCTOR_ID,
            date: new Date('2026-09-15T12:00:00.000Z'),
            time: '10:40',
            specialty: 'fonoaudiologia',
            operationalStatus: 'completed',
            billingType: 'particular'
        });
        appointment._fromCompleteService = true;
        await appointment.save();

        const session = new Session({
            patient: patientId,
            doctor: DOCTOR_ID,
            appointmentId: appointment._id,
            date: appointment.date,
            time: '10:40',
            sessionType: 'fonoaudiologia',
            status: 'completed',
            sessionValue: 160
        });
        session._fromCompleteService = true;
        await session.save();
        await Appointment.updateOne({ _id: appointment._id }, { $set: { session: session._id } });

        const retroactivePayment = await Payment.create({
            patient: patientId,
            doctor: DOCTOR_ID,
            appointment: appointment._id,
            session: session._id,
            amount: 160,
            paymentDate: new Date(),
            paymentMethod: 'pix',
            billingType: 'particular',
            kind: 'session_payment',
            status: 'pending'
        });

        // Ledger legado quebrado — 5 lançamentos sem description, sem
        // relação com esta paciente/sessão (reproduz o achado real: mesmo
        // patient, mas appointments/sessions totalmente diferentes).
        await PatientBalance.collection.insertOne({
            patient: patientId,
            currentBalance: 1000,
            totalDebited: 1000,
            totalCredited: 0,
            transactions: [
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() }
            ],
            createdAt: new Date(),
            updatedAt: new Date()
        });

        return { patientId, appointment, session, retroactivePayment };
    }

    function buildRequest({ patientId, retroactivePaymentId, calculationMode }) {
        return {
            body: {
                patientId: patientId.toString(),
                doctorId: DOCTOR_ID.toString(),
                specialty: 'fonoaudiologia',
                sessionType: 'fonoaudiologia',
                totalSessions: 8,
                sessionValue: 160,
                totalValue: 1280,
                type: 'package',
                model: 'prepaid',
                paymentType: 'full',
                calculationMode, // ignorado pelo backend — ver comentário do arquivo
                date: '2026-09-15',
                time: '10:40',
                durationMonths: 1,
                sessionsPerWeek: 2,
                frequencyInterval: 'weekly',
                schedule: [
                    { date: '2026-09-17', time: '09:20' },
                    { date: '2026-09-22', time: '10:40' },
                    { date: '2026-09-24', time: '09:20' },
                    { date: '2026-09-29', time: '10:40' },
                    { date: '2026-10-01', time: '09:20' },
                    { date: '2026-10-06', time: '10:40' },
                    { date: '2026-10-08', time: '09:20' }
                ],
                payments: [{ amount: 1120, method: 'cartao_credito', date: '2026-09-15' }],
                preConsumedCount: 1,
                retroactivePaymentIds: [retroactivePaymentId.toString()],
                retroactivePaymentMethod: 'cartao_credito',
                retroactivePaymentDate: '2026-09-15',
                name: 'Pacote E2E',
                modality: 'presencial'
            },
            user: { _id: new mongoose.Types.ObjectId() }
        };
    }

    function makeRes() {
        return {
            status(code) { this.statusCode = code; return this; },
            json(data) { this.data = data; return this; }
        };
    }

    // MongoMemoryReplSet: a primeira transação multi-documento depois do
    // replset subir pode esbarrar em "catalog changes" por artefato de
    // inicialização (não reproduz num MongoDB real já rodando) — a própria
    // resposta da API já marca isso como `retryable: true`. Retry aqui
    // espelha exatamente o que um client real faria com esse contrato,
    // sem mascarar nenhum outro tipo de falha.
    async function createPackageWithRetryOnTransientCatalogChange(req, maxAttempts = 3) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const res = makeRes();
            await createPackageV2(req, res);
            if (res.data?.errorCode !== 'MONGO_CATALOG_CHANGE' || attempt === maxAttempts) return res;
        }
    }

    it.each(['duration', 'sessions'])(
        'cria o pacote, quita a sessão selecionada, mantém 7 futuras pagas-não-concluídas e não toca no ledger legado (calculationMode=%s)',
        async (calculationMode) => {
            const { patientId, appointment, retroactivePayment } = await setupPatientWithRetroactiveSession(calculationMode);
            const req = buildRequest({ patientId, retroactivePaymentId: retroactivePayment._id, calculationMode });

            const res = await createPackageWithRetryOnTransientCatalogChange(req);

            if (res.statusCode !== 201) {
                console.log('createPackageV2 falhou:', JSON.stringify(res.data, null, 2));
            }
            expect(res.statusCode).toBe(201);
            expect(res.data.success).toBe(true);

            const pkg = await Package.findById(res.data.data.packageId ?? res.data.data._id ?? res.data.data.package?._id);
            expect(pkg).toBeTruthy();
            expect(pkg.totalPaid).toBe(1280);
            expect(pkg.totalValue).toBe(1280);
            expect(pkg.financialStatus).toBe('paid');

            // R$1.280 recebidos, e a metade das sessões futuras (R$1.120) numa
            // ÚNICA transação — não duplicada.
            const packagePayments = await Payment.find({ package: pkg._id });
            const futurePayments = packagePayments.filter(p => p.kind === 'package_receipt' && p.amount === 1120);
            expect(futurePayments).toHaveLength(1); // R$1.120 recebido numa ÚNICA transação, não duplicado
            // packagePayments já inclui o Payment retroativo (incorporatePackagePayments
            // vincula payment.package = pkg._id) — somar de novo seria contar 2x.
            const totalReceived = packagePayments.reduce((s, p) => s + p.amount, 0);
            expect(totalReceived).toBe(1280);

            // Sessão selecionada: concluída (já estava) e agora QUITADA.
            const updatedAppointment = await Appointment.findById(appointment._id);
            expect(updatedAppointment.operationalStatus).toBe('completed');
            expect(updatedAppointment.paymentStatus).toBe('paid');
            expect(updatedAppointment.isPaid).toBe(true);
            expect(updatedAppointment.package.toString()).toBe(pkg._id.toString());

            const updatedRetroactivePayment = await Payment.findById(retroactivePayment._id);
            expect(updatedRetroactivePayment.status).toBe('paid');

            // 7 sessões futuras: pagas (prepaid) mas NÃO concluídas.
            const futureAppointments = await Appointment.find({ package: pkg._id, _id: { $ne: appointment._id } });
            expect(futureAppointments).toHaveLength(7);
            futureAppointments.forEach(a => {
                expect(a.operationalStatus).toBe('scheduled');
                expect(a.isPaid).toBe(true);
            });

            // Histórico legado: presente, intocado, sem description (não bloqueou nada).
            const balance = await PatientBalance.findOne({ patient: patientId });
            const untouchedLegacy = balance.transactions.filter(t => !t.description && t.type === 'debit');
            expect(untouchedLegacy).toHaveLength(5);
            untouchedLegacy.forEach(t => expect(t.amount).toBe(200));
        }
    );

    it('falha intermediária não deixa persistência parcial (Package/Appointments/Payments/PatientBalance)', async () => {
        const { patientId, appointment, retroactivePayment } = await setupPatientWithRetroactiveSession('fail');
        const req = buildRequest({ patientId, retroactivePaymentId: retroactivePayment._id, calculationMode: 'sessions' });
        const res = makeRes();

        // Injeta falha no ÚLTIMO passo antes do commit (vincular pacote ao
        // paciente) — maximiza quanto já foi escrito na transação antes de
        // estourar, pra provar que o rollback desfaz TUDO (Package,
        // Appointments, Sessions, Payment retroativo, crédito no
        // PatientBalance), não só parte.
        const spy = vi.spyOn(Patient, 'findByIdAndUpdate').mockImplementation(() => {
            throw new Error('FALHA_INJETADA_ANTES_DO_COMMIT');
        });

        try {
            await createPackageV2(req, res);
        } finally {
            spy.mockRestore();
        }

        if (res.statusCode !== 500) {
            console.log('esperava 500, resposta real:', JSON.stringify(res.data, null, 2));
        }
        expect(res.statusCode).toBe(500);

        const pkgCount = await Package.countDocuments({ patient: patientId });
        expect(pkgCount).toBe(0);

        const newAppointments = await Appointment.countDocuments({ patient: patientId, _id: { $ne: appointment._id } });
        expect(newAppointments).toBe(0);

        const untouchedRetroactivePayment = await Payment.findById(retroactivePayment._id);
        expect(untouchedRetroactivePayment.status).toBe('pending'); // não virou 'paid'
        expect(untouchedRetroactivePayment.package).toBeFalsy();

        const untouchedAppointment = await Appointment.findById(appointment._id);
        expect(untouchedAppointment.paymentStatus).not.toBe('paid');
        expect(untouchedAppointment.package).toBeFalsy();

        const balance = await PatientBalance.findOne({ patient: patientId });
        expect(balance.currentBalance).toBe(1000); // nenhum crédito aplicado
        expect(balance.transactions.filter(t => t.type === 'credit')).toHaveLength(0);
    });
});

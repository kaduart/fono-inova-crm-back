/**
 * 🛡️ appointmentWorker.confirmAppointment — correção do TOCTOU (2026-08-25)
 *
 * Contexto: confirmAppointment() fazia um write incondicional de
 * operationalStatus='scheduled', sem checar o estado atual. Entre o guard do
 * worker (só aceita 'pending'/'processing_create') e este write, rodam
 * validações assíncronas — uma janela real em que o usuário pode cancelar o
 * Appointment. Sem compare-and-set, o write final reativava o agendamento
 * cancelado por cima, silenciosamente (achado em auditoria de 157 Appointments
 * com o mesmo padrão de reativação — ver back/docs, investigação 2026-08-25).
 *
 * Estes testes usam MongoDB real em memória (mongodb-memory-server) porque o
 * comportamento sob teste É o compare-and-set atômico do Mongo — um mock não
 * reproduz uma corrida de verdade. O lado "cancelamento" da corrida é simulado
 * escrevendo diretamente os campos que cancelAppointmentCommand.executeWithSession
 * escreveria no Appointment (operationalStatus/history) — a lógica própria
 * daquele command (Payment, Package, outbox) já tem cobertura dedicada em
 * tests/cancelAppointmentCommand.test.js; aqui o foco é só a corrida com o worker.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import { confirmAppointment } from '../../workers/appointmentWorker.js';

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 30000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Appointment.deleteMany({});
    await Session.deleteMany({});
});

// 🔧 Fixtures via driver raw (collection.insertOne), não Appointment.create()/.save():
// 'validating' não é um enum válido no schema (a produção só "funciona" porque
// findByIdAndUpdate pula validação por padrão — o próprio worker depende disso),
// e há um hook pre-save que bloqueia operationalStatus='completed' fora do
// completeSessionService. Testar "dado um Appointment no estado X" não deveria
// exercitar essas regras de transição — só o estado inicial precisa existir.
async function insertAppointmentFixture(overrides = {}) {
    const doc = {
        _id: new mongoose.Types.ObjectId(),
        patient: new mongoose.Types.ObjectId(),
        doctor: new mongoose.Types.ObjectId(),
        date: new Date('2026-09-01T12:00:00Z'),
        time: '10:00',
        specialty: 'psicologia',
        operationalStatus: 'validating',
        clinicalStatus: 'pending',
        history: [
            { action: 'appointment_requested', newStatus: 'pending', timestamp: new Date('2026-08-30T10:00:00Z') },
            { action: 'validation_started', newStatus: 'validating', timestamp: new Date('2026-08-30T10:00:01Z') },
        ],
        ...overrides,
    };
    await Appointment.collection.insertOne(doc);
    return doc;
}

/** Simula o efeito do cancelAppointmentCommand sobre o Appointment (mesmos campos-chave). */
async function simulateCancelation(appointmentId) {
    return Appointment.findByIdAndUpdate(
        appointmentId,
        {
            $set: {
                operationalStatus: 'canceled',
                clinicalStatus: 'pending',
                canceledAt: new Date(),
                cancelReason: 'Cancelado via Web App',
                _fromCancelService: true,
            },
            $push: {
                history: { action: 'cancelamento', newStatus: 'canceled', timestamp: new Date(), context: 'operacional' },
            },
        },
        { new: true }
    );
}

describe('appointmentWorker.confirmAppointment — compare-and-set (TOCTOU fix)', () => {
    it('A) confirmação normal: validating -> scheduled, com history correto', async () => {
        const appt = await insertAppointmentFixture();

        const result = await confirmAppointment(appt._id);

        expect(result.confirmed).toBe(true);
        expect(result.appointment.operationalStatus).toBe('scheduled');
        const last = result.appointment.history[result.appointment.history.length - 1];
        expect(last.action).toBe('appointment_confirmed');
        expect(last.newStatus).toBe('scheduled');
    });

    it('B) corrida cancelamento x confirmação: CAS falha, Appointment permanece canceled', async () => {
        const appt = await insertAppointmentFixture();

        // Worker chegou em 'validating'. Enquanto roda validações, o usuário cancela
        // (mesmo efeito líquido do cancelAppointmentCommand sobre o Appointment).
        await simulateCancelation(appt._id);

        // Worker retoma e tenta confirmar — CAS deve falhar (documento não está mais 'validating')
        const result = await confirmAppointment(appt._id);

        expect(result.confirmed).toBe(false);
        expect(result.currentStatus).toBe('canceled');

        const final = await Appointment.findById(appt._id).lean();
        expect(final.operationalStatus).toBe('canceled'); // nunca restaurado pra scheduled
        const lastEvent = final.history[final.history.length - 1];
        expect(lastEvent.action).toBe('cancelamento'); // nenhum appointment_confirmed depois do cancelamento
        expect(final.history.some(h => h.action === 'appointment_confirmed')).toBe(false);
    });

    it('C) retry idempotente: Appointment já scheduled não é reprocessado nem duplica history', async () => {
        const appt = await insertAppointmentFixture();

        const first = await confirmAppointment(appt._id);
        expect(first.confirmed).toBe(true);

        // Segunda tentativa (ex: retry de job BullMQ) — já não está mais 'validating'
        const second = await confirmAppointment(appt._id);
        expect(second.confirmed).toBe(false);

        const final = await Appointment.findById(appt._id).lean();
        const confirmedEntries = final.history.filter(h => h.action === 'appointment_confirmed');
        expect(confirmedEntries.length).toBe(1); // não duplicou
        expect(final.operationalStatus).toBe('scheduled');
    });

    it('D) estado inesperado: completed/canceled não voltam para scheduled via confirmAppointment', async () => {
        const apptCompleted = await insertAppointmentFixture({ operationalStatus: 'completed', clinicalStatus: 'completed' });
        const resultCompleted = await confirmAppointment(apptCompleted._id);
        expect(resultCompleted.confirmed).toBe(false);
        expect((await Appointment.findById(apptCompleted._id).lean()).operationalStatus).toBe('completed');

        const apptCanceled = await insertAppointmentFixture({ operationalStatus: 'canceled' });
        const resultCanceled = await confirmAppointment(apptCanceled._id);
        expect(resultCanceled.confirmed).toBe(false);
        expect((await Appointment.findById(apptCanceled._id).lean()).operationalStatus).toBe('canceled');
    });

    it('E) Session vinculada permanece coerente quando a confirmação é abortada (stale)', async () => {
        const session = await Session.create({
            date: new Date('2026-09-01T12:00:00Z'),
            time: '10:00',
            sessionType: 'psicologia',
            doctor: new mongoose.Types.ObjectId(),
            patient: new mongoose.Types.ObjectId(),
            status: 'canceled',
        });
        const appt = await insertAppointmentFixture({ session: session._id });

        await simulateCancelation(appt._id);

        const result = await confirmAppointment(appt._id);
        expect(result.confirmed).toBe(false);

        // confirmAppointment nunca escreve em Session — permanece exatamente como o cancelamento deixou
        const finalSession = await Session.findById(session._id).lean();
        expect(finalSession.status).toBe('canceled');

        const finalAppt = await Appointment.findById(appt._id).lean();
        expect(finalAppt.operationalStatus).toBe('canceled');
        // Nunca "Appointment scheduled com Session canceled"
        expect(finalAppt.operationalStatus).not.toBe('scheduled');
    });
});

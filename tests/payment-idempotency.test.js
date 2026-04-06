/**
 * 🛡️ Testes de Idempotência - Payment Worker
 * 
 * Valida 3 camadas de proteção:
 * 1. EventStore check (eventId já processado)
 * 2. Payment.findOne (já existe para este appointment)
 * 3. Índice único no DB + tratamento E11000 (race condition)
 */

const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const EventStore = require('../models/EventStore');
const { processEvent } = require('../workers/paymentWorker');
const { EventTypes } = require('../utils/eventTypes');

// Mock do MongoDB
beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/crm_test_idempotency');
    await Payment.deleteMany({});
    await EventStore.deleteMany({});
});

afterAll(async () => {
    await Payment.deleteMany({});
    await EventStore.deleteMany({});
    await mongoose.connection.close();
});

describe('🛡️ Idempotência - Payment Creation', () => {
    const correlationId = 'test-correlation-123';
    const appointmentId = new mongoose.Types.ObjectId();
    const patientId = new mongoose.Types.ObjectId();
    const doctorId = new mongoose.Types.ObjectId();
    
    const baseEvent = {
        type: EventTypes.PAYMENT_REQUESTED,
        payload: {
            appointmentId: appointmentId.toString(),
            patientId: patientId.toString(),
            doctorId: doctorId.toString(),
            amount: 150.00,
            paymentMethod: 'pix'
        },
        metadata: { correlationId }
    };

    it('Camada 1: Não processa o mesmo eventId duas vezes', async () => {
        const eventId = 'unique-event-id-001';
        
        // Primeira execução
        const result1 = await processEvent({ ...baseEvent, eventId });
        expect(result1.status).toBe('payment_confirmed');
        
        // Segunda execução (mesmo eventId)
        const result2 = await processEvent({ ...baseEvent, eventId });
        expect(result2.status).toBe('already_processed');
        
        // Deve existir apenas 1 pagamento
        const count = await Payment.countDocuments({ appointment: appointmentId });
        expect(count).toBe(1);
    });

    it('Camada 2: Não cria pagamento duplicado para mesmo appointment', async () => {
        const newAppointmentId = new mongoose.Types.ObjectId();
        const event1 = {
            ...baseEvent,
            eventId: 'event-002',
            payload: { ...baseEvent.payload, appointmentId: newAppointmentId.toString() }
        };
        const event2 = {
            ...baseEvent,
            eventId: 'event-003',
            payload: { ...baseEvent.payload, appointmentId: newAppointmentId.toString() }
        };
        
        // Primeiro evento - cria pagamento
        const result1 = await processEvent(event1);
        expect(result1.status).toBe('payment_confirmed');
        
        // Segundo evento - detecta duplicidade
        const result2 = await processEvent(event2);
        expect(result2.status).toBe('already_pending');
        
        // Apenas 1 pagamento
        const count = await Payment.countDocuments({ appointment: newAppointmentId });
        expect(count).toBe(1);
    });

    it('Camada 3: Índice único previne race condition (simulado)', async () => {
        const raceAppointmentId = new mongoose.Types.ObjectId();
        
        // Cria pagamento direto (simulando outro worker/process)
        await Payment.create({
            appointment: raceAppointmentId,
            patient: patientId,
            doctor: doctorId,
            amount: 200.00,
            status: 'pending',
            source: 'appointment',
            correlationId: 'other-correlation'
        });
        
        // Tenta criar outro (deve ser barrado pelo índice único)
        const event = {
            ...baseEvent,
            eventId: 'event-004',
            payload: { 
                ...baseEvent.payload, 
                appointmentId: raceAppointmentId.toString(),
                amount: 200.00
            }
        };
        
        const result = await processEvent(event);
        
        // Deve detectar duplicidade (via findOne ou índice único)
        expect(['already_pending', 'already_exists']).toContain(result.status);
        
        // Apenas 1 pagamento
        const count = await Payment.countDocuments({ appointment: raceAppointmentId });
        expect(count).toBe(1);
    });

    it('Permite múltiplos pagamentos manuais para mesmo appointment', async () => {
        const manualAppointmentId = new mongoose.Types.ObjectId();
        
        // Pagamento automático do appointment
        await Payment.create({
            appointment: manualAppointmentId,
            patient: patientId,
            amount: 100.00,
            status: 'pending',
            source: 'appointment'
        });
        
        // Pagamento manual adicional (deve ser permitido)
        await Payment.create({
            appointment: manualAppointmentId,
            patient: patientId,
            amount: 50.00,
            status: 'pending',
            source: 'manual',
            notes: 'Taxa adicional'
        });
        
        const count = await Payment.countDocuments({ appointment: manualAppointmentId });
        expect(count).toBe(2);
    });

    it('Permite pagamento de pacote (package) independente do appointment', async () => {
        const packageAppointmentId = new mongoose.Types.ObjectId();
        
        // Pagamento normal do appointment
        await Payment.create({
            appointment: packageAppointmentId,
            patient: patientId,
            amount: 100.00,
            status: 'pending',
            source: 'appointment'
        });
        
        // Pagamento de pacote (mesmo appointment, source diferente)
        await Payment.create({
            appointment: packageAppointmentId,
            patient: patientId,
            amount: 500.00,
            status: 'pending',
            source: 'package',
            isFromPackage: true
        });
        
        const count = await Payment.countDocuments({ appointment: packageAppointmentId });
        expect(count).toBe(2);
    });
});

describe('📊 Performance - Processamento Concorrente', () => {
    it('Processa 100 eventos simultâneos sem duplicidade', async () => {
        const appointmentIds = Array.from({ length: 100 }, () => ({
            id: new mongoose.Types.ObjectId(),
            eventId: `perf-event-${Math.random().toString(36).substr(2, 9)}`
        }));
        
        // Dispara todos ao mesmo tempo
        const promises = appointmentIds.map(({ id, eventId }) => 
            processEvent({
                type: EventTypes.PAYMENT_REQUESTED,
                eventId,
                payload: {
                    appointmentId: id.toString(),
                    patientId: new mongoose.Types.ObjectId().toString(),
                    amount: 100.00
                },
                metadata: { correlationId: 'perf-test' }
            })
        );
        
        const results = await Promise.all(promises);
        
        // Todos devem ser confirmados
        const confirmed = results.filter(r => r.status === 'payment_confirmed').length;
        expect(confirmed).toBe(100);
        
        // Não deve haver duplicados
        const dbCount = await Payment.countDocuments({ correlationId: 'perf-test' });
        expect(dbCount).toBe(100);
    });
});

// Teste rápido do fluxo Insurance
import mongoose from 'mongoose';
import InsuranceBatch from './insurance/batch/InsuranceBatch.js';
import { publishEvent } from './infrastructure/events/eventPublisher.js';
import { InsuranceEventTypes } from './insurance/events/insuranceEvents.js';

async function test() {
    try {
        await mongoose.connect('mongodb://localhost:27017/crm');
        console.log('✅ MongoDB conectado');

        // Cria um lote de teste
        const batch = new InsuranceBatch({
            batchNumber: 'UNIMED-20260329-TEST001',
            insuranceProvider: 'unimed',
            startDate: new Date('2026-03-01'),
            endDate: new Date('2026-03-31'),
            items: [{
                sessionId: new mongoose.Types.ObjectId(),
                appointmentId: new mongoose.Types.ObjectId(),
                patientId: new mongoose.Types.ObjectId(),
                sessionDate: new Date(),
                procedureCode: '40301015',
                procedureName: 'Sessão de Psicoterapia',
                grossAmount: 150.00
            }],
            totalItems: 1,
            totalGross: 150.00,
            pendingCount: 1,
            status: 'pending'
        });

        await batch.save();
        console.log('✅ Lote criado:', batch._id.toString());

        // Publica evento
        const result = await publishEvent(
            InsuranceEventTypes.INSURANCE_BATCH_CREATED,
            {
                batchId: batch._id.toString(),
                batchNumber: batch.batchNumber,
                insuranceProvider: batch.insuranceProvider,
                totalItems: batch.totalItems,
                totalGross: batch.totalGross
            }
        );

        console.log('✅ Evento publicado:', result.eventId);
        console.log('📊 Job ID:', result.jobId);
        console.log('🎉 Teste concluído! Verifique os logs do worker.');

        await mongoose.disconnect();
        process.exit(0);

    } catch (error) {
        console.error('❌ Erro:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

test();

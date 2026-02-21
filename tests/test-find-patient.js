// Script para verificar o paciente específico
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

async function findPatient() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        const { default: Patient } = await import('../models/Patient.js');
        const { default: Payment } = await import('../models/Payment.js');

        const patientId = '698f0ad139d78a9c5746e037';

        console.log(`🔍 Buscando paciente: ${patientId}`);
        
        // Buscar por string
        const patientByString = await Patient.findById(patientId).lean();
        console.log('   Por string:', patientByString ? 'ENCONTRADO' : 'NÃO ENCONTRADO');
        
        if (patientByString) {
            console.log('   Nome:', patientByString.fullName);
        }

        // Buscar com ObjectId
        try {
            const patientByObjectId = await Patient.findById(new mongoose.Types.ObjectId(patientId)).lean();
            console.log('   Por ObjectId:', patientByObjectId ? 'ENCONTRADO' : 'NÃO ENCONTRADO');
        } catch (e) {
            console.log('   Por ObjectId: ERRO -', e.message);
        }

        // Verificar se o ID é válido
        console.log('\n📋 Informações sobre o ID:');
        console.log('   É válido como ObjectId?', mongoose.Types.ObjectId.isValid(patientId));
        
        // Listar todos os pacientes (só os primeiros 10)
        console.log('\n📋 Primeiros 10 pacientes do banco:');
        const allPatients = await Patient.find().select('_id fullName').limit(10).lean();
        for (const p of allPatients) {
            console.log(`   - ${p._id}: ${p.fullName}`);
        }

        // Verificar os pagamentos desse paciente
        console.log('\n📋 Pagamentos vinculados a esse paciente:');
        const payments = await Payment.find({ patient: patientId }).select('_id billingType insurance.provider').lean();
        console.log(`   Total: ${payments.length} pagamentos`);
        for (const p of payments) {
            console.log(`   - ${p._id}: ${p.billingType} - ${p.insurance?.provider || 'N/A'}`);
        }

        // Verificar se há algum paciente com nome similar
        console.log('\n📋 Buscando pacientes com nome similar (se houver dados parciais):');
        const similarPatients = await Patient.find({
            $or: [
                { fullName: { $regex: 'anapolis', $options: 'i' } },
                { fullName: { $regex: 'unimed', $options: 'i' } }
            ]
        }).select('_id fullName').limit(5).lean();
        
        if (similarPatients.length > 0) {
            for (const p of similarPatients) {
                console.log(`   - ${p._id}: ${p.fullName}`);
            }
        } else {
            console.log('   Nenhum paciente encontrado com esses critérios');
        }

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

findPatient();

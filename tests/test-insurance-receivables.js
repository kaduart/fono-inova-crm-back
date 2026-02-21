// Script de teste para o endpoint /api/payments/insurance/receivables
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

async function testInsuranceReceivables() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB');

        // Importar o modelo Payment
        const { default: Payment } = await import('../models/Payment.js');
        const { default: Patient } = await import('../models/Patient.js');

        console.log('\n📊 Testando aggregation de recebíveis de convênio...\n');

        const match = {
            billingType: 'convenio',
            'insurance.status': { $in: ['pending_billing', 'billed'] }
        };

        const receivables = await Payment.aggregate([
            { $match: match },
            // Fazer lookup do paciente
            {
                $lookup: {
                    from: 'patients',
                    localField: 'patient',
                    foreignField: '_id',
                    as: 'patientInfo'
                }
            },
            // Desestruturar o array do lookup - CORREÇÃO: extrair fullName corretamente
            {
                $addFields: {
                    patientName: {
                        $ifNull: [
                            { $arrayElemAt: ['$patientInfo.fullName', 0] },
                            'Paciente não identificado'
                        ]
                    }
                }
            },
            // Agrupar por convênio
            {
                $group: {
                    _id: '$insurance.provider',
                    totalPending: { $sum: '$insurance.grossAmount' },
                    count: { $sum: 1 },
                    payments: {
                        $push: {
                            paymentId: '$_id',
                            patient: '$patient',
                            patientName: '$patientName',
                            grossAmount: '$insurance.grossAmount',
                            status: '$insurance.status',
                            paymentDate: '$paymentDate',
                            authorizationCode: '$insurance.authorizationCode'
                        }
                    }
                }
            },
            { $sort: { totalPending: -1 } }
        ]);

        console.log(`📋 Encontrados ${receivables.length} convênios com recebíveis\n`);

        for (const group of receivables) {
            console.log(`\n🏥 Convênio: ${group._id}`);
            console.log(`   Total: R$ ${group.totalPending.toFixed(2)} | ${group.count} atendimentos`);
            console.log('   Pagamentos:');
            
            for (const payment of group.payments.slice(0, 5)) { // Mostrar só os 5 primeiros
                console.log(`      - ${payment.patientName} (R$ ${payment.grossAmount.toFixed(2)}) - ${payment.status}`);
            }
            
            if (group.payments.length > 5) {
                console.log(`      ... e mais ${group.payments.length - 5} pagamentos`);
            }
        }

        // Verificar se há pagamentos com "Paciente não identificado"
        const unidentifiedPayments = receivables.flatMap(g => 
            g.payments.filter(p => p.patientName === 'Paciente não identificado')
        );

        console.log(`\n\n⚠️  Pagamentos com paciente não identificado: ${unidentifiedPayments.length}`);
        
        if (unidentifiedPayments.length > 0) {
            console.log('\n   Detalhes dos primeiros 5:');
            for (const p of unidentifiedPayments.slice(0, 5)) {
                console.log(`      - ID: ${p.paymentId}`);
                console.log(`        Patient ID: ${p.patient || 'NULL'}`);
                console.log(`        Valor: R$ ${p.grossAmount.toFixed(2)}`);
                console.log(`        Data: ${p.paymentDate}`);
                console.log('');
            }
        }

        // Testar auditoria
        console.log('\n\n🔍 Executando auditoria...\n');
        
        const allPayments = await Payment.find({
            billingType: 'convenio'
        }).select('patient insurance.provider insurance.grossAmount insurance.status paymentDate').lean();

        const issues = [];
        const patientIds = new Set();

        for (const payment of allPayments) {
            if (!payment.patient) {
                issues.push({
                    paymentId: payment._id.toString(),
                    issue: 'MISSING_PATIENT',
                    details: 'Pagamento sem paciente vinculado'
                });
                continue;
            }
            patientIds.add(payment.patient.toString());
        }

        const patientIdsArray = Array.from(patientIds);
        const existingPatients = await Patient.find({
            _id: { $in: patientIdsArray }
        }).select('_id fullName').lean();

        const existingPatientIds = new Set(existingPatients.map(p => p._id.toString()));

        for (const payment of allPayments) {
            if (!payment.patient) continue;
            const patientId = payment.patient.toString();
            if (!existingPatientIds.has(patientId)) {
                issues.push({
                    paymentId: payment._id.toString(),
                    issue: 'PATIENT_NOT_FOUND',
                    patientId: patientId,
                    details: `Paciente ${patientId} não encontrado no banco`
                });
            }
        }

        console.log('📊 Estatísticas da Auditoria:');
        console.log(`   Total de pagamentos de convênio: ${allPayments.length}`);
        console.log(`   Com paciente: ${allPayments.filter(p => p.patient).length}`);
        console.log(`   Sem paciente: ${allPayments.filter(p => !p.patient).length}`);
        console.log(`   Pacientes únicos: ${patientIds.size}`);
        console.log(`   Pacientes existentes: ${existingPatientIds.size}`);
        console.log(`   Pacientes não encontrados: ${patientIds.size - existingPatientIds.size}`);
        console.log(`   Total de problemas: ${issues.length}`);

        if (issues.length > 0) {
            console.log('\n   ⚠️  Problemas encontrados:');
            for (const issue of issues.slice(0, 10)) {
                console.log(`      - ${issue.issue}: ${issue.details}`);
            }
            if (issues.length > 10) {
                console.log(`      ... e mais ${issues.length - 10} problemas`);
            }
        }

        console.log('\n✅ Teste concluído!');

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

testInsuranceReceivables();

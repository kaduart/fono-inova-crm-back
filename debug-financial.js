// Script para diagnosticar e corrigir o problema do dashboard financeiro
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

async function diagnose() {
    console.log('🔍 DIAGNÓSTICO FINANCEIRO\n');
    
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    
    // 1. Verifica payments em abril/2026
    console.log('1️⃣ Payments em abril/2026:');
    const paymentsAbril = await db.collection('payments').countDocuments({
        $or: [
            { paymentDate: { $gte: new Date('2026-04-01'), $lte: new Date('2026-04-30') } },
            { createdAt: { $gte: new Date('2026-04-01'), $lte: new Date('2026-04-30') } }
        ]
    });
    console.log(`   Total: ${paymentsAbril}`);
    
    // 2. Verifica payments PAID em abril/2026
    console.log('\n2️⃣ Payments PAID em abril/2026:');
    const paidAbril = await db.collection('payments').countDocuments({
        status: 'paid',
        $or: [
            { paymentDate: { $gte: new Date('2026-04-01'), $lte: new Date('2026-04-30') } },
            { createdAt: { $gte: new Date('2026-04-01'), $lte: new Date('2026-04-30') } }
        ]
    });
    console.log(`   Total: ${paidAbril}`);
    
    // 3. Soma dos payments PAID
    console.log('\n3️⃣ Valor total dos PAID:');
    const sumResult = await db.collection('payments').aggregate([
        {
            $match: {
                status: 'paid',
                $or: [
                    { paymentDate: { $gte: new Date('2026-04-01'), $lte: new Date('2026-04-30') } },
                    { createdAt: { $gte: new Date('2026-04-01'), $lte: new Date('2026-04-30') } }
                ]
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$amount' }
            }
        }
    ]).toArray();
    console.log(`   Total: R$ ${sumResult[0]?.total || 0}`);
    
    // 4. Mostra 3 exemplos
    console.log('\n4️⃣ Exemplos de payments:');
    const examples = await db.collection('payments').find({
        status: 'paid'
    }, {
        projection: { status: 1, amount: 1, paymentDate: 1, createdAt: 1, billingType: 1 }
    }).sort({ createdAt: -1 }).limit(3).toArray();
    
    examples.forEach((p, i) => {
        console.log(`   ${i+1}. R$ ${p.amount} - ${p.status}`);
        console.log(`      paymentDate: ${p.paymentDate}`);
        console.log(`      createdAt: ${p.createdAt}`);
        console.log(`      billingType: ${p.billingType}`);
    });
    
    // 5. Verifica se há snapshots
    console.log('\n5️⃣ Snapshots existentes:');
    const snapshots = await db.collection('totalsnapshots').countDocuments();
    console.log(`   Total: ${snapshots}`);
    
    // 6. Cria snapshot manual se necessário
    if (paidAbril > 0) {
        console.log('\n✅ Criando snapshot manual para abril/2026...');
        
        const totalReceived = sumResult[0]?.total || 0;
        
        await db.collection('totalsnapshots').insertOne({
            clinicId: 'default',
            date: '2026-04-04',
            period: 'month',
            periodStart: new Date('2026-04-01'),
            periodEnd: new Date('2026-04-30'),
            totals: {
                totalReceived: totalReceived,
                totalProduction: totalReceived,
                totalPending: 0,
                totalPartial: 0,
                countReceived: paidAbril,
                countPending: 0,
                countPartial: 0,
                particularReceived: totalReceived,
                particularCountReceived: paidAbril,
                insurance: {
                    pendingBilling: 0,
                    billed: 0,
                    received: 0
                },
                totalInsuranceProduction: 0,
                totalInsuranceReceived: 0,
                totalInsurancePending: 0,
                countInsuranceTotal: 0,
                countInsuranceReceived: 0,
                countInsurancePending: 0,
                packageCredit: {
                    contractedRevenue: 0,
                    cashReceived: 0,
                    deferredRevenue: 0,
                    deferredSessions: 0,
                    recognizedRevenue: 0,
                    recognizedSessions: 0,
                    totalSessions: 0,
                    activePackages: 0
                },
                patientBalance: {
                    totalDebt: 0,
                    totalCredit: 0,
                    totalDebited: 0,
                    totalCredited: 0,
                    patientsWithDebt: 0,
                    patientsWithCredit: 0
                },
                expenses: {
                    total: 0,
                    pending: 0,
                    count: 0
                },
                profit: totalReceived,
                profitMargin: 100,
                byMethod: {
                    dinheiro: { amount: 0, count: 0 },
                    pix: { amount: 0, count: 0 },
                    cartao_credito: { amount: 0, count: 0 },
                    cartao_debito: { amount: 0, count: 0 },
                    convenio: { amount: 0, count: 0 }
                }
            },
            blockingErrors: [],
            validations: [],
            insights: [],
            calculatedAt: new Date(),
            calculatedBy: 'debug_script',
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            createdAt: new Date(),
            updatedAt: new Date()
        });
        
        console.log('✅ Snapshot criado com sucesso!');
        console.log(`   Caixa: R$ ${totalReceived}`);
        console.log(`   Produção: R$ ${totalReceived}`);
    } else {
        console.log('\n❌ Nenhum payment PAID encontrado para abril/2026');
    }
    
    await mongoose.disconnect();
    console.log('\n🏁 Diagnóstico concluído!');
}

diagnose().catch(err => {
    console.error('Erro:', err);
    process.exit(1);
});

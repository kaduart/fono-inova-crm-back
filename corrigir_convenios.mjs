import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function corrigir() {
    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection.db;
    
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║     CORREÇÃO EM MASSA - PACOTES DE CONVÊNIO                      ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    
    // 1. EXCLUIR TODOS OS PAYMENTS ÓRFÃOS (sem sessão)
    console.log('1. Excluindo payments órfãos...');
    const todosPayments = await db.collection('payments').find({
        billingType: 'convenio',
        paymentDate: { $regex: '^2026-0(2|3)' }
    }).toArray();
    
    let excluidos = 0;
    for (const p of todosPayments) {
        const sessao = await db.collection('appointments').findOne({ _id: p.appointment });
        if (!sessao) {
            await db.collection('payments').deleteOne({ _id: p._id });
            excluidos++;
        }
    }
    console.log(`   ✓ ${excluidos} payments órfãos excluídos\n`);
    
    // 2. CRIAR PAYMENTS PARA SESSÕES CONFIRMADAS SEM PAYMENT
    console.log('2. Criando payments para sessões sem payment...');
    const pkgIds = await db.collection('packages').distinct('_id', { type: 'convenio' });
    
    let criados = 0;
    for (const pkgId of pkgIds) {
        const pkg = await db.collection('packages').findOne({ _id: pkgId });
        if (!pkg) continue;
        
        const sessoesSemPay = await db.collection('appointments').find({
            package: pkgId,
            date: { $gte: '2026-02-01', $lte: '2026-03-31' },
            operationalStatus: 'confirmed'
        }).toArray();
        
        for (const s of sessoesSemPay) {
            // Verificar se já existe payment para esta sessão
            const payExistente = await db.collection('payments').findOne({
                appointment: s._id
            });
            
            if (!payExistente) {
                // Criar payment
                await db.collection('payments').insertOne({
                    patient: s.patient,
                    appointment: s._id,
                    package: pkgId,
                    amount: pkg.insuranceGrossAmount || 80,
                    paymentMethod: 'convenio',
                    billingType: 'convenio',
                    status: 'pending',
                    paymentDate: s.date,
                    insurance: {
                        provider: pkg.insuranceProvider,
                        grossAmount: pkg.insuranceGrossAmount || 80,
                        status: 'pending_billing'
                    },
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                
                // Atualizar sessão
                await db.collection('appointments').updateOne(
                    { _id: s._id },
                    { $set: { paymentStatus: 'pending_billing' } }
                );
                
                criados++;
            }
        }
    }
    console.log(`   ✓ ${criados} payments criados\n`);
    
    // 3. VERIFICAR SE HÁ SESSÕES CANCELADAS COM PAYMENT
    console.log('3. Verificando sessões canceladas com payment...');
    const canceladasComPay = await db.collection('appointments').find({
        package: { $in: pkgIds },
        date: { $gte: '2026-02-01', $lte: '2026-03-31' },
        operationalStatus: 'canceled'
    }).toArray();
    
    let removidos = 0;
    for (const s of canceladasComPay) {
        const pay = await db.collection('payments').findOne({ appointment: s._id });
        if (pay) {
            await db.collection('payments').deleteOne({ _id: pay._id });
            removidos++;
        }
    }
    console.log(`   ✓ ${removidos} payments de sessões canceladas removidos\n`);
    
    // 4. RESUMO FINAL
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('CORREÇÃO CONCLUÍDA!');
    console.log(`   - Payments órfãos excluídos: ${excluidos}`);
    console.log(`   - Payments criados: ${criados}`);
    console.log(`   - Payments de canceladas removidos: ${removidos}`);
    console.log('═══════════════════════════════════════════════════════════════════');
    
    await mongoose.disconnect();
}

corrigir().catch(console.error);

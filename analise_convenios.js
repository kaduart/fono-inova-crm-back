const mongoose = require('mongoose');
require('dotenv').config();

async function analiseCompleta() {
    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection.db;
    
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║     ANÁLISE COMPLETA - PACOTES DE CONVÊNIO (FEV/MAR 2026)        ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    
    // Buscar todos os pacotes de convênio com sessões em fev/mar
    const pkgIds = await db.collection('appointments').distinct('package', {
        date: { $gte: '2026-02-01', $lte: '2026-03-31' },
        operationalStatus: 'confirmed'
    });
    
    const pacotes = await db.collection('packages').find({
        _id: { $in: pkgIds },
        type: 'convenio'
    }).toArray();
    
    console.log(`Total de pacotes de convênio: ${pacotes.length}\n`);
    
    let totalProblemas = 0;
    
    for (const pkg of pacotes) {
        const paciente = await db.collection('patients').findOne({ _id: pkg.patient });
        const nome = paciente?.fullName || 'N/A';
        
        // Sessões confirmadas
        const sessoesConf = await db.collection('appointments').find({
            package: pkg._id,
            date: { $gte: '2026-02-01', $lte: '2026-03-31' },
            operationalStatus: 'confirmed'
        }).toArray();
        
        // Payments
        const payments = await db.collection('payments').find({
            package: pkg._id,
            paymentDate: { $regex: '^2026-0(2|3)' }
        }).toArray();
        
        // Verificar payments órfãos
        const orfaos = [];
        for (const p of payments) {
            const s = await db.collection('appointments').findOne({ _id: p.appointment });
            if (!s) orfaos.push({ data: p.paymentDate, id: p._id.toString().slice(-8) });
        }
        
        // Verificar sessões sem payment
        const semPay = [];
        for (const s of sessoesConf) {
            const p = await db.collection('payments').findOne({ appointment: s._id });
            if (!p) semPay.push({ data: s.date, hora: s.time });
        }
        
        // Verificar canceladas com payment
        const canceladasComPay = [];
        const canceladas = await db.collection('appointments').find({
            package: pkg._id,
            date: { $gte: '2026-02-01', $lte: '2026-03-31' },
            operationalStatus: 'canceled'
        }).toArray();
        
        for (const s of canceladas) {
            const p = await db.collection('payments').findOne({ appointment: s._id });
            if (p) canceladasComPay.push({ data: s.date, hora: s.time });
        }
        
        if (orfaos.length > 0 || semPay.length > 0 || canceladasComPay.length > 0) {
            totalProblemas++;
            console.log('─────────────────────────────────────────────────────────────────');
            console.log(`PACIENTE: ${nome}`);
            console.log(`PACOTE: ${pkg.specialty} | Sessões: ${sessoesConf.length} | Payments: ${payments.length}`);
            
            if (orfaos.length > 0) {
                console.log(`⚠️  PAYMENTS ÓRFÃOS (${orfaos.length}):`);
                orfaos.forEach(o => console.log(`    → ${o.data} | ID: ${o.id}`));
            }
            
            if (semPay.length > 0) {
                console.log(`⚠️  SESSÕES SEM PAYMENT (${semPay.length}):`);
                semPay.forEach(s => console.log(`    → ${s.data} ${s.hora}`));
            }
            
            if (canceladasComPay.length > 0) {
                console.log(`❌ CANCELADAS COM PAYMENT (${canceladasComPay.length}):`);
                canceladasComPay.forEach(s => console.log(`    → ${s.data} ${s.hora}`));
            }
            console.log('');
        }
    }
    
    console.log('═══════════════════════════════════════════════════════════════════');
    if (totalProblemas === 0) {
        console.log('✓ NENHUM PROBLEMA ENCONTRADO!');
    } else {
        console.log(`⚠️  PACOTES COM PROBLEMAS: ${totalProblemas}/${pacotes.length}`);
    }
    console.log('═══════════════════════════════════════════════════════════════════');
    
    await mongoose.disconnect();
}

analiseCompleta().catch(console.error);

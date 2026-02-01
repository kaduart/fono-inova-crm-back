// Script para verificar documentos de convênio
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';

async function checkInsurance() {
    await mongoose.connect(process.env.MONGODB_URI);
    
    console.log("🔍 Verificando convênios...\n");
    
    // Contar total de convênios
    const totalConvenios = await Payment.countDocuments({ billingType: 'convenio' });
    console.log(`Total de convênios: ${totalConvenios}`);
    
    // Contar com insurance preenchido
    const withInsurance = await Payment.countDocuments({ 
        billingType: 'convenio',
        'insurance.provider': { $exists: true, $ne: null }
    });
    console.log(`Com insurance.provider preenchido: ${withInsurance}`);
    
    // Contar com insurance null
    const withNullInsurance = await Payment.countDocuments({ 
        billingType: 'convenio',
        $or: [
            { insurance: null },
            { 'insurance.provider': null }
        ]
    });
    console.log(`Com insurance null: ${withNullInsurance}`);
    
    // Mostrar exemplos
    console.log("\n📋 Exemplos de convênios:");
    const examples = await Payment.find({ billingType: 'convenio' })
        .select('billingType insurance paymentDate createdAt')
        .limit(5)
        .lean();
    
    examples.forEach((ex, i) => {
        console.log(`\n${i + 1}. ID: ${ex._id}`);
        console.log(`   billingType: ${ex.billingType}`);
        console.log(`   insurance: ${JSON.stringify(ex.insurance)}`);
        console.log(`   paymentDate: ${ex.paymentDate}`);
        console.log(`   createdAt: ${ex.createdAt}`);
    });
    
    await mongoose.disconnect();
}

checkInsurance().catch(console.error);

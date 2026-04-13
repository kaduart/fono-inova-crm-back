// jobs/checkPayments.js - Diagnóstico de Payments
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import dotenv from 'dotenv';

dotenv.config();

async function check() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/crm');
    
    console.log("🔍 DIAGNÓSTICO DE PAYMENTS\n");
    
    // Total de payments
    const total = await Payment.countDocuments();
    console.log(`Total de payments: ${total}`);
    
    // Payments por status
    const byStatus = await Payment.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    console.log("\nPor status:");
    byStatus.forEach(s => console.log(`  ${s._id}: ${s.count}`));
    
    // Payments paid sem billingType
    const paidSemBilling = await Payment.countDocuments({ 
        status: 'paid', 
        $or: [{ billingType: null }, { billingType: { $exists: false } }] 
    });
    console.log(`\nPayments 'paid' SEM billingType: ${paidSemBilling}`);
    
    // Payments paid sem paymentDate
    const paidSemDate = await Payment.countDocuments({ 
        status: 'paid', 
        $or: [{ paymentDate: null }, { paymentDate: { $exists: false } }] 
    });
    console.log(`Payments 'paid' SEM paymentDate: ${paidSemDate}`);
    
    // Payments paid sem patient
    const paidSemPatient = await Payment.countDocuments({ 
        status: 'paid', 
        $or: [{ patient: null }, { patient: { $exists: false } }] 
    });
    console.log(`Payments 'paid' SEM patient: ${paidSemPatient}`);
    
    // Últimos 5 payments criados
    console.log("\nÚltimos 5 payments:");
    const recentes = await Payment.find().sort({ createdAt: -1 }).limit(5).lean();
    recentes.forEach(p => {
        console.log(`  ${p._id} | status: ${p.status} | billing: ${p.billingType} | date: ${p.paymentDate?.toISOString().split('T')[0]} | patient: ${p.patient ? 'OK' : 'FALTA'}`);
    });
    
    // Teste: Contar payments do mês atual
    const startOfMonth = new Date(2026, 3, 1); // Abril 2026
    const endOfMonth = new Date(2026, 3, 30);
    
    const doMes = await Payment.countDocuments({
        status: 'paid',
        paymentDate: { $gte: startOfMonth, $lte: endOfMonth }
    });
    console.log(`\nPayments 'paid' em Abril/2026: ${doMes}`);
    
    // Teste: Contar com financialDate
    const comFinDate = await Payment.countDocuments({
        status: 'paid',
        financialDate: { $gte: startOfMonth, $lte: endOfMonth }
    });
    console.log(`Payments 'paid' com financialDate em Abril/2026: ${comFinDate}`);
    
    await mongoose.disconnect();
}

check().catch(console.error);

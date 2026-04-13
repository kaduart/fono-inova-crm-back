// jobs/fixPayments.js - Corrige payments sem billingType
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import dotenv from 'dotenv';

dotenv.config();

async function fix() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/crm');
    
    console.log("🔧 CORRIGINDO PAYMENTS\n");
    
    // 1. Corrige payments 'paid' sem billingType
    const result1 = await Payment.updateMany(
        { 
            status: 'paid',
            $or: [{ billingType: null }, { billingType: { $exists: false } }]
        },
        { $set: { billingType: 'particular' } }
    );
    console.log(`✅ Payments 'paid' corrigidos: ${result1.modifiedCount}`);
    
    // 2. Corrige payments pending que deveriam ser paid (tem paidAt)
    const result2 = await Payment.updateMany(
        { 
            status: 'pending',
            paidAt: { $exists: true, $ne: null }
        },
        { $set: { status: 'paid' } }
    );
    console.log(`✅ Payments 'pending' → 'paid': ${result2.modifiedCount}`);
    
    // 3. Corrige financialDate faltando em payments paid
    const result3 = await Payment.updateMany(
        { 
            status: 'paid',
            $or: [{ financialDate: null }, { financialDate: { $exists: false } }]
        },
        [
            { $set: { financialDate: { $ifNull: ['$paidAt', '$paymentDate', '$createdAt'] } } }
        ]
    );
    console.log(`✅ financialDate corrigidos: ${result3.modifiedCount}`);
    
    console.log("\n🏁 Feito!");
    await mongoose.disconnect();
}

fix().catch(console.error);

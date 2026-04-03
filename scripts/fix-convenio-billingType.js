/**
 * 🔧 SCRIPT DE CORREÇÃO: billingType de convênio
 * 
 * Problema: Appointments de pacotes de convênio estão com billingType="particular"
 * Solução: Atualizar para billingType="convenio"
 */

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';

async function fixConvenioBillingType() {
  console.log('🔧 Iniciando correção de billingType para convênios...\n');
  
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/crm');
  
  // 1. Buscar todos os pacotes de convênio
  const convenioPackages = await Package.find({ type: 'convenio' }).select('_id');
  const packageIds = convenioPackages.map(p => p._id.toString());
  
  console.log(`📦 Encontrados ${packageIds.length} pacotes de convênio`);
  
  // 2. Buscar appointments vinculados a esses pacotes com billingType errado
  const appointmentsToFix = await Appointment.find({
    package: { $in: packageIds },
    $or: [
      { billingType: 'particular' },
      { billingType: { $exists: false } }
    ]
  });
  
  console.log(`🎯 Encontrados ${appointmentsToFix.length} appointments para corrigir`);
  
  // 3. Atualizar cada appointment
  let fixed = 0;
  for (const appt of appointmentsToFix) {
    const oldBillingType = appt.billingType;
    
    appt.billingType = 'convenio';
    await appt.save();
    
    console.log(`  ✅ ${appt._id}: "${oldBillingType}" → "convenio"`);
    fixed++;
  }
  
  console.log(`\n✅ ${fixed} appointments corrigidos com sucesso!`);
  
  await mongoose.disconnect();
  process.exit(0);
}

fixConvenioBillingType().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});

// scripts/reset-all-stuck.js
// Reseta TODOS os agendamentos travados em processing_complete

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

async function resetAllStuck() {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado\n');

    const stuckStatuses = ['processing_complete', 'processing_cancel', 'processing_create'];
    
    for (const status of stuckStatuses) {
      const stuck = await Appointment.find({ operationalStatus: status });
      
      if (stuck.length === 0) {
        console.log(`📭 Nenhum agendamento em '${status}'`);
        continue;
      }

      console.log(`\n🚨 Encontrados ${stuck.length} agendamento(s) em '${status}':`);
      
      for (const apt of stuck) {
        const newStatus = status === 'processing_create' ? 'pending' : 'scheduled';
        
        apt.operationalStatus = newStatus;
        apt.history.push({
          action: 'batch_reset',
          previousStatus: status,
          newStatus: newStatus,
          timestamp: new Date(),
          context: 'Reset em massa - script de emergência'
        });
        
        await apt.save();
        console.log(`   ✅ Resetado: ${apt._id} → ${newStatus} (${apt.date?.toISOString().split('T')[0]} ${apt.time})`);
      }
    }

    console.log('\n✅ Todos os agendamentos foram resetados!');

  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

resetAllStuck();

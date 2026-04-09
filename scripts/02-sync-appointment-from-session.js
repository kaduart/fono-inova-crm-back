// 2️⃣ SINCRONIZAR APPOINTMENT ← SESSION
// Appointment reflete o que está na Session (fonte de verdade)
//
// Regra: Session manda, Appointment segue

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function syncAppointment() {
  console.log('========================================');
  console.log('2️⃣ SYNC APPOINTMENT ← SESSION');
  console.log(`MODO: ${DRY_RUN ? 'DRY RUN' : 'EXECUÇÃO REAL'}`);
  console.log('========================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado ao MongoDB\n');

  const stats = {
    sessionsComValor: 0,
    appointmentsAtualizados: 0,
    statusCorrigidos: 0,
    valorCorrigidos: 0,
    semAppointment: 0,
    erros: []
  };

  // Buscar sessions que têm valor válido
  const sessions = await Session.find({
    value: { $gt: 0 },
    isDeleted: { $ne: true }
  }).limit(1000);

  console.log(`📋 ${sessions.length} sessions com valor válido\n`);

  for (const session of sessions) {
    try {
      stats.sessionsComValor++;

      // Buscar appointment relacionado
      const appointment = await Appointment.findOne({
        $or: [
          { _id: session.appointmentId },
          { session: session._id }
        ]
      });

      if (!appointment) {
        stats.semAppointment++;
        console.log(`⚠️ Session ${session._id} sem appointment relacionado`);
        continue;
      }

      let precisaAtualizar = false;
      let updateData = {};
      let mudancas = [];

      // ========================================
      // SINCRONIZAR STATUS
      // ========================================
      const statusMap = {
        'completed': 'completed',
        'canceled': 'canceled',
        'missed': 'missed',
        'scheduled': 'scheduled',
        'pending': 'pending'
      };

      const sessionStatus = statusMap[session.status];
      if (sessionStatus && appointment.operationalStatus !== sessionStatus) {
        updateData.operationalStatus = sessionStatus;
        precisaAtualizar = true;
        stats.statusCorrigidos++;
        mudancas.push(`status: ${appointment.operationalStatus} → ${sessionStatus}`);
      }

      // ========================================
      // SINCRONIZAR VALOR
      // ========================================
      if (session.value > 0 && appointment.sessionValue !== session.value) {
        // Só atualiza se o valor do appointment está zerado ou muito diferente
        if (!appointment.sessionValue || appointment.sessionValue <= 0.1 || 
            Math.abs(appointment.sessionValue - session.value) > 1) {
          updateData.sessionValue = session.value;
          precisaAtualizar = true;
          stats.valorCorrigidos++;
          mudancas.push(`valor: ${appointment.sessionValue} → ${session.value}`);
        }
      }

      // ========================================
      // APLICAR ATUALIZAÇÃO
      // ========================================
      if (precisaAtualizar) {
        console.log(`${DRY_RUN ? '[DRY]' : '[SYNC]'} ${appointment._id}`);
        console.log(`    Session: ${session._id} (${session.status})`);
        mudancas.forEach(m => console.log(`    → ${m}`));
        console.log('');

        if (!DRY_RUN) {
          // Adicionar histórico
          const historyEntry = {
            action: 'sync_from_session',
            timestamp: new Date(),
            sessionId: session._id,
            changes: mudancas
          };

          await Appointment.updateOne(
            { _id: appointment._id },
            {
              $set: updateData,
              $push: { history: historyEntry }
            }
          );
        }
        stats.appointmentsAtualizados++;
      }

    } catch (error) {
      console.error(`❌ Erro:`, error.message);
      stats.erros.push({ sessionId: session._id, error: error.message });
    }
  }

  // RELATÓRIO
  console.log('\n========================================');
  console.log('📊 RELATÓRIO');
  console.log('========================================');
  console.log(`Sessions com valor: ${stats.sessionsComValor}`);
  console.log(`Appointments atualizados: ${stats.appointmentsAtualizados}`);
  console.log(`  → Status corrigidos: ${stats.statusCorrigidos}`);
  console.log(`  → Valores corrigidos: ${stats.valorCorrigidos}`);
  console.log(`Sem appointment: ${stats.semAppointment}`);
  console.log(`Erros: ${stats.erros.length}`);

  if (DRY_RUN) {
    console.log('\n⚠️ DRY RUN - Nenhuma alteração salva!');
    console.log('Para executar: DRY_RUN=false node 02-sync-appointment-from-session.js');
  } else {
    console.log('\n✅ Sincronização concluída!');
  }

  await mongoose.disconnect();
  console.log('\n👋 Done!');
  process.exit(0);
}

syncAppointment().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});

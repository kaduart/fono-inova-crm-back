/**
 * 🔄 MIGRAÇÃO: Padroniza status de Patient (lead / active / inactive)
 *
 * Contexto: novos campos adicionados ao Patient schema:
 *   - status: 'lead' | 'active' | 'inactive'
 *   - isLead: boolean
 *   - convertedAt: Date
 *   - firstSessionAt: Date
 *   - lastSessionAt: Date
 *
 * Regras:
 *   1. Patients sem `status` → inferir com base em appointments/sessions
 *   2. Patients que NUNCA tiveram sessão completada → 'lead'
 *   3. Patients com PELO MENOS 1 sessão completada → 'active'
 *   4. Patients com sessão completada há > 6 meses → 'inactive' (opcional)
 */

import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/crm');
  console.log('🚀 Iniciando migração de Patient status...\n');

  // ─── PASSO 1: Patients sem status definido ────────────────────
  const patientsWithoutStatus = await Patient.find({
    $or: [
      { status: { $exists: false } },
      { status: null }
    ]
  }).select('_id fullName');

  console.log(`📊 Patients sem status: ${patientsWithoutStatus.length}`);

  // ─── PASSO 2: Buscar appointments completados por patient ─────
  const patientIds = patientsWithoutStatus.map(p => p._id.toString());

  const completedAppointments = await Appointment.aggregate([
    {
      $match: {
        patient: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) },
        operationalStatus: 'completed'
      }
    },
    {
      $group: {
        _id: '$patient',
        count: { $sum: 1 },
        firstSession: { $min: '$date' },
        lastSession: { $max: '$date' }
      }
    }
  ]);

  const completedMap = new Map();
  for (const item of completedAppointments) {
    completedMap.set(item._id.toString(), {
      count: item.count,
      firstSession: item.firstSession,
      lastSession: item.lastSession
    });
  }

  // ─── PASSO 3: Atualizar patients ──────────────────────────────
  let updatedLeads = 0;
  let updatedActive = 0;
  let updatedInactive = 0;

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  for (const patient of patientsWithoutStatus) {
    const pid = patient._id.toString();
    const data = completedMap.get(pid);

    if (!data || data.count === 0) {
      // Nunca teve sessão completada → lead
      await Patient.updateOne(
        { _id: patient._id },
        {
          $set: {
            status: 'lead',
            isLead: true
          },
          $setOnInsert: {
            convertedAt: null,
            firstSessionAt: null,
            lastSessionAt: null
          }
        }
      );
      updatedLeads++;
    } else if (data.lastSession < sixMonthsAgo) {
      // Teve sessão, mas há mais de 6 meses → inactive
      await Patient.updateOne(
        { _id: patient._id },
        {
          $set: {
            status: 'inactive',
            isLead: false,
            convertedAt: data.firstSession,
            firstSessionAt: data.firstSession,
            lastSessionAt: data.lastSession
          }
        }
      );
      updatedInactive++;
    } else {
      // Teve sessão recente → active
      await Patient.updateOne(
        { _id: patient._id },
        {
          $set: {
            status: 'active',
            isLead: false,
            convertedAt: data.firstSession,
            firstSessionAt: data.firstSession,
            lastSessionAt: data.lastSession
          }
        }
      );
      updatedActive++;
    }
  }

  console.log(`\n✅ Migração concluída:`);
  console.log(`   → Leads: ${updatedLeads}`);
  console.log(`   → Ativos: ${updatedActive}`);
  console.log(`   → Inativos: ${updatedInactive}`);
  console.log(`   → Total: ${updatedLeads + updatedActive + updatedInactive}`);

  // ─── PASSO 4: Resumo geral ────────────────────────────────────
  const summary = await Patient.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  console.log(`\n📊 Distribuição atual:`);
  for (const item of summary) {
    console.log(`   → ${item._id || 'sem status'}: ${item.count}`);
  }

  await mongoose.disconnect();
  console.log('\n👋 Done');
}

run().catch(err => {
  console.error('❌ Erro na migração:', err);
  process.exit(1);
});

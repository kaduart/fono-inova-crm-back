import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Doctor from '../models/Doctor.js';
import { calculateCommissionBatch, calculateSessionCommission } from '../services/commissionRule.service.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Busca uma sessão completed de um profissional com valor > 0
  const session = await Session.findOne({
    status: 'completed',
    sessionValue: { $gt: 0 },
    professionalPaymentStatus: { $ne: 'non_payable' }
  }).populate('doctor', 'fullName specialty commissionRules commissionRuleVersion')
    .lean();

  if (!session) {
    console.log('Nenhuma sessão completed com valor > 0 encontrada.');
    await mongoose.disconnect();
    return;
  }

  const doctor = session.doctor;
  console.log(`\n=== Sessão de teste ===`);
  console.log(`  id=${session._id}`);
  console.log(`  profissional=${doctor.fullName} (${doctor._id})`);
  console.log(`  valor=${session.sessionValue}`);
  console.log(`  status=${session.status}`);
  console.log(`  professionalPaymentStatus=${session.professionalPaymentStatus || 'payable'}`);

  // Cálculo payable
  const commissionPayable = calculateSessionCommission(doctor, session);
  console.log(`\nComissão com professionalPaymentStatus=payable: R$ ${commissionPayable.toFixed(2)}`);

  // Simula non_payable
  const sessionNonPayable = { ...session, professionalPaymentStatus: 'non_payable' };
  const commissionNonPayable = calculateSessionCommission(doctor, sessionNonPayable);
  console.log(`Comissão com professionalPaymentStatus=non_payable: R$ ${commissionNonPayable.toFixed(2)}`);

  // Batch com produção mantida
  const batchPayable = calculateCommissionBatch(doctor, [session]);
  const batchNonPayable = calculateCommissionBatch(doctor, [sessionNonPayable]);
  console.log(`\nBatch payable:`);
  console.log(`  produção total: R$ ${batchPayable.totalProductionBase.toFixed(2)}`);
  console.log(`  comissão total: R$ ${batchPayable.totalCommission.toFixed(2)}`);
  console.log(`  sessões standard: ${batchPayable.breakdown.standardSessions.count}`);
  console.log(`Batch non_payable:`);
  console.log(`  produção total: R$ ${batchNonPayable.totalProductionBase.toFixed(2)} (deve ser igual)`);
  console.log(`  comissão total: R$ ${batchNonPayable.totalCommission.toFixed(2)} (deve ser 0)`);
  console.log(`  sessões standard: ${batchNonPayable.breakdown.standardSessions.count} (deve ser 0)`);

  // Testa atualização real da flag
  console.log(`\n=== Atualizando sessão no banco para non_payable ===`);
  const updated = await Session.findByIdAndUpdate(
    session._id,
    {
      professionalPaymentStatus: 'non_payable',
      professionalPaymentOverride: {
        excluded: true,
        reason: 'Teste de validação do script',
        excludedAt: new Date(),
        excludedBy: null
      },
      $push: {
        professionalPaymentOverrideHistory: {
          status: 'non_payable',
          reason: 'Teste de validação do script',
          changedAt: new Date(),
          changedBy: null
        }
      }
    },
    { new: true }
  ).lean();

  console.log(`  professionalPaymentStatus=${updated.professionalPaymentStatus}`);
  console.log(`  override=${JSON.stringify(updated.professionalPaymentOverride)}`);
  console.log(`  histórico=${updated.professionalPaymentOverrideHistory.length} entrada(s)`);

  // Restaura
  await Session.findByIdAndUpdate(
    session._id,
    {
      professionalPaymentStatus: 'payable',
      professionalPaymentOverride: { excluded: false, reason: null, excludedAt: null, excludedBy: null },
      $push: {
        professionalPaymentOverrideHistory: {
          status: 'payable',
          reason: 'Restauração após teste de validação',
          changedAt: new Date(),
          changedBy: null
        }
      }
    }
  );
  console.log(`\n✅ Sessão restaurada para payable.`);

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

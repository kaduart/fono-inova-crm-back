import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Doctor from '../models/Doctor.js';
import Session from '../models/Session.js';
import Expense from '../models/Expense.js';
import { calculateSessionCommission } from '../services/commissionRule.service.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const start = new Date('2026-06-01T00:00:00-03:00');
  const end = new Date('2026-06-30T23:59:59-03:00');

  const commissionExpenses = await Expense.find({
    category: 'commission',
    date: { $gte: '2026-06-01', $lte: '2026-06-30' }
  }).populate('relatedDoctor', 'fullName specialty commissionRules').lean();

  console.log(`Comparando ${commissionExpenses.length} despesas de comissão de junho/2026\n`);

  for (const exp of commissionExpenses) {
    const doctor = exp.relatedDoctor;
    if (!doctor) continue;

    const sessions = await Session.find({
      doctor: doctor._id,
      date: { $gte: start, $lte: end },
      status: 'completed'
    }).populate('package', 'sessionType totalSessions').lean();

    let recalculated = 0;
    for (const session of sessions) {
      const sessionType = (session.sessionType || session.package?.sessionType || '').toLowerCase();
      // Espelha o skip de neuropsych_evaluation em pacote que calculateCommissionBatch faz (processado à parte)
      if ((sessionType === 'neuropsych_evaluation' || sessionType === 'neuropsychological') && session.package) {
        continue;
      }
      recalculated += calculateSessionCommission(doctor, session, session.date);
    }
    recalculated = Math.round(recalculated * 100) / 100;

    const stored = exp.amount;
    const diff = Math.round((recalculated - stored) * 100) / 100;
    const status = Math.abs(diff) < 0.01 ? '✅ BATE' : '❌ DIVERGE';

    console.log(`${status} | ${doctor.fullName.padEnd(28)} (${doctor.specialty || '?'}) | sessions=${sessions.length} | gerado=R$${stored} | recalculado=R$${recalculated} | diff=R$${diff}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

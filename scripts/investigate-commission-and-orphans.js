#!/usr/bin/env node
/**
 * 🔍 INVESTIGAÇÃO: Comissão e Sessões sem Pagamento
 *
 * Uso:
 *   node scripts/investigate-commission-and-orphans.js --start=2026-06-01 --end=2026-06-30
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Doctor from '../models/Doctor.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (const arg of args) {
    if (arg.startsWith('--start=')) result.startDate = arg.split('=')[1];
    if (arg.startsWith('--end=')) result.endDate = arg.split('=')[1];
  }
  return result;
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI ou MONGO_URI não encontrado');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✅ MongoDB conectado\n');
}

async function disconnect() {
  await mongoose.disconnect();
  console.log('\n👋 MongoDB desconectado');
}

async function main() {
  const { startDate, endDate } = parseArgs();
  await connect();

  try {
    const start = new Date(startDate || '2026-06-01');
    const end = new Date(endDate || '2026-06-30');
    end.setHours(23, 59, 59, 999);

    console.log('================================================');
    console.log('INVESTIGAÇÃO: COMISSÃO E SESSÕES SEM PAGAMENTO');
    console.log('================================================\n');

    // ── 1. Amostra de sessões completed ──
    console.log('1. AMOSTRA DE 10 SESSÕES COMPLETED');
    console.log('────────────────────────────────────────────────');
    const sample = await Session.find({
      date: { $gte: start, $lte: end },
      status: 'completed'
    })
      .populate('doctor', 'fullName specialty commissionRules')
      .populate('patient', 'fullName')
      .limit(10)
      .lean();

    for (const s of sample) {
      console.log(`Sessão: ${s._id}`);
      console.log(`  Data: ${s.date?.toISOString()?.slice(0, 10)}`);
      console.log(`  Paciente: ${s.patient?.fullName || 'N/A'}`);
      console.log(`  Profissional: ${s.doctor?.fullName || 'N/A'}`);
      console.log(`  sessionValue: ${s.sessionValue}`);
      console.log(`  commissionRate: ${s.commissionRate}`);
      console.log(`  commissionValue: ${s.commissionValue}`);
      console.log(`  paymentMethod: ${s.paymentMethod}`);
      console.log(`  paymentOrigin: ${s.paymentOrigin}`);
      console.log(`  paymentStatus: ${s.paymentStatus}`);
      console.log(`  package: ${s.package || 'null'}`);
      console.log(`  insuranceGuide: ${s.insuranceGuide || 'null'}`);
      console.log(`  Doctor.commissionRules.standardSession: ${s.doctor?.commissionRules?.standardSession || 'N/A'}`);
      console.log('');
    }

    // ── 2. Estatísticas de comissão ──
    console.log('\n2. ESTATÍSTICAS DE COMISSÃO');
    console.log('────────────────────────────────────────────────');
    const commissionStats = await Session.aggregate([
      { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          withRate: { $sum: { $cond: [{ $gt: ['$commissionRate', 0] }, 1, 0] } },
          withValue: { $sum: { $cond: [{ $gt: ['$commissionValue', 0] }, 1, 0] } },
          totalCommissionValue: { $sum: '$commissionValue' }
        }
      }
    ]);

    const stats = commissionStats[0] || { total: 0, withRate: 0, withValue: 0, totalCommissionValue: 0 };
    console.log(`Total sessões: ${stats.total}`);
    console.log(`Com commissionRate > 0: ${stats.withRate}`);
    console.log(`Com commissionValue > 0: ${stats.withValue}`);
    console.log(`Soma commissionValue: ${stats.totalCommissionValue}`);

    // ── 3. Sessões sem pagamento vinculado ──
    console.log('\n3. SESSÕES SEM PAGAMENTO VINCULADO');
    console.log('────────────────────────────────────────────────');

    const sessions = await Session.find({
      date: { $gte: start, $lte: end },
      status: 'completed'
    })
      .populate('package', 'sessionValue totalValue totalSessions type model paymentType')
      .populate('patient', 'fullName')
      .populate('doctor', 'fullName specialty')
      .lean();

    const payments = await Payment.find({
      status: 'paid',
      amount: { $gt: 0 },
      kind: { $ne: 'package_consumed' }
    })
      .populate('session', '_id')
      .populate('appointment', '_id')
      .lean();

    const paidSessionIds = new Set();
    const paidAppointmentIds = new Set();
    for (const p of payments) {
      if (p.session?._id) paidSessionIds.add(p.session._id.toString());
      if (p.appointment?._id) paidAppointmentIds.add(p.appointment._id.toString());
    }

    const orphanSessions = sessions.filter(s => {
      if (paidSessionIds.has(s._id.toString())) return false;
      if (s.appointmentId && paidAppointmentIds.has(s.appointmentId.toString())) return false;
      return true;
    });

    const classification = {
      package: 0,
      convenio: 0,
      liminar: 0,
      particular: 0,
      unknown: 0
    };

    for (const s of orphanSessions) {
      const method = (s.paymentMethod || '').toLowerCase();
      const origin = (s.paymentOrigin || '').toLowerCase();

      if (method === 'liminar_credit' || origin.includes('liminar')) {
        classification.liminar += 1;
      } else if (method === 'convenio' || origin.includes('convenio') || s.insuranceGuide) {
        classification.convenio += 1;
      } else if (s.package) {
        classification.package += 1;
      } else if (method === 'dinheiro' || method === 'pix' || method === 'cartão' || method === 'cartao' || origin === 'individual' || origin === 'auto_per_session') {
        classification.particular += 1;
      } else {
        classification.unknown += 1;
      }
    }

    console.log(`Total sessões sem pagamento vinculado: ${orphanSessions.length}`);
    console.log(`  Cobertas por pacote: ${classification.package}`);
    console.log(`  Convênio: ${classification.convenio}`);
    console.log(`  Liminar: ${classification.liminar}`);
    console.log(`  Particular pendente: ${classification.particular}`);
    console.log(`  Indefinido: ${classification.unknown}`);

    // ── 4. Amostra de órfãos por tipo ──
    console.log('\n4. AMOSTRA DE ÓRFÃOS POR TIPO');
    console.log('────────────────────────────────────────────────');

    const showSample = (type, condition) => {
      const list = orphanSessions.filter(condition).slice(0, 3);
      if (list.length === 0) return;
      console.log(`\n${type}:`);
      for (const s of list) {
        console.log(`  ${s._id} | ${s.date?.toISOString()?.slice(0, 10)} | ${s.patient?.fullName || 'N/A'} | Prof: ${s.doctor?.fullName || 'N/A'} | Valor: ${resolveSessionFinancialValue(s)} | method: ${s.paymentMethod} | origin: ${s.paymentOrigin} | package: ${s.package ? 'sim' : 'não'}`);
      }
    };

    showSample('Pacote', s => s.package);
    showSample('Convênio', s => {
      const m = (s.paymentMethod || '').toLowerCase();
      const o = (s.paymentOrigin || '').toLowerCase();
      return m === 'convenio' || o.includes('convenio') || s.insuranceGuide;
    });
    showSample('Liminar', s => {
      const m = (s.paymentMethod || '').toLowerCase();
      const o = (s.paymentOrigin || '').toLowerCase();
      return m === 'liminar_credit' || o.includes('liminar');
    });
    showSample('Particular', s => {
      const m = (s.paymentMethod || '').toLowerCase();
      return m === 'dinheiro' || m === 'pix' || m === 'cartão' || m === 'cartao';
    });
    showSample('Indefinido', s => {
      const m = (s.paymentMethod || '').toLowerCase();
      const o = (s.paymentOrigin || '').toLowerCase();
      return !s.package && m !== 'convenio' && !o.includes('convenio') && !s.insuranceGuide && m !== 'liminar_credit' && !o.includes('liminar') && m !== 'dinheiro' && m !== 'pix' && m !== 'cartão' && m !== 'cartao';
    });

    // ── 5. Comissão por profissional ──
    console.log('\n5. COMISSÃO POR PROFISSIONAL (se houver)');
    console.log('────────────────────────────────────────────────');
    const byDoctor = {};
    for (const s of sessions) {
      const did = s.doctor?._id?.toString() || 'sem';
      if (!byDoctor[did]) {
        byDoctor[did] = {
          name: s.doctor?.fullName || 'Sem profissional',
          total: 0,
          withValue: 0,
          totalCommission: 0
        };
      }
      byDoctor[did].total += 1;
      if (s.commissionValue > 0) {
        byDoctor[did].withValue += 1;
        byDoctor[did].totalCommission += s.commissionValue;
      }
    }

    for (const d of Object.values(byDoctor).sort((a, b) => b.total - a.total)) {
      console.log(`  ${d.name}: ${d.total} sessões | ${d.withValue} com comissão | total: ${d.totalCommission}`);
    }

    console.log('\n================================================');
    console.log('FIM DA INVESTIGAÇÃO');
    console.log('================================================');

  } catch (error) {
    console.error('\n❌ Erro:', error.message);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}

main();

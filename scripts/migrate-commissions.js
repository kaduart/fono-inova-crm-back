/**
 * 🔄 Migration: Preencher commissionRate e commissionValue
 * 
 * Estratégia:
 * 1. Buscar configuração de comissão por especialidade/doutor
 * 2. Calcular commissionValue = sessionValue * rate
 * 3. Só para sessões completed
 * 
 * Uso: node scripts/migrate-commissions.js [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI;
const isDryRun = process.argv.includes('--dry-run');

// Schemas
const sessionSchema = new mongoose.Schema({
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  specialty: String,
  sessionValue: Number,
  commissionRate: Number,
  commissionValue: Number,
  status: String
}, { timestamps: true });

const doctorSchema = new mongoose.Schema({
  fullName: String,
  specialty: String,
  commissionRate: Number
}, { timestamps: true });

// Taxas padrão por especialidade
const DEFAULT_RATES = {
  'fonoaudiologia': 0.50,
  'terapia_ocupacional': 0.45,
  'psicologia': 0.40,
  'fisioterapia': 0.50,
  'psicomotricidade': 0.45,
  'musicoterapia': 0.50,
  'psicopedagogia': 0.45,
  'avaliacao': 0.50
};

async function migrate() {
  console.log(`🔄 Migrando comissões ${isDryRun ? '(DRY RUN)' : ''}...\n`);

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const Session = mongoose.model('Session', sessionSchema);
    const Doctor = mongoose.model('Doctor', doctorSchema);

    // Buscar sessões completed sem comissão calculada
    // 🛡️ NÃO sobrescreve comissões já existentes (preserva histórico)
    const sessions = await Session.find({
      status: 'completed',
      sessionValue: { $gt: 0 },
      $or: [
        { commissionValue: { $exists: false } },
        { commissionValue: null }
        // 🚫 NÃO incluímos commissionValue: 0 porque pode ser comissão zero legítima
      ]
    }).limit(1000);

    console.log(`📊 Encontradas ${sessions.length} sessões para calcular comissão\n`);

    if (sessions.length === 0) {
      console.log('✅ Nenhuma sessão precisa de atualização');
      return;
    }

    // Cache de doutores
    const doctorCache = new Map();

    let updated = 0;
    let skipped = 0;
    let errors = [];

    for (const session of sessions) {
      try {
        let commissionRate = null;
        let source = '';

        // 1️⃣ Tentar obter do doutor
        if (session.doctor) {
          if (!doctorCache.has(session.doctor.toString())) {
            const doctor = await Doctor.findById(session.doctor).lean();
            doctorCache.set(session.doctor.toString(), doctor);
          }
          const doctor = doctorCache.get(session.doctor.toString());
          if (doctor?.commissionRate) {
            commissionRate = doctor.commissionRate;
            source = 'doctor.commissionRate';
          }
        }

        // 2️⃣ Fallback: especialidade
        if (!commissionRate && session.specialty) {
          const specialty = session.specialty.toLowerCase();
          for (const [key, rate] of Object.entries(DEFAULT_RATES)) {
            if (specialty.includes(key)) {
              commissionRate = rate;
              source = `default.${key}`;
              break;
            }
          }
        }

        // 3️⃣ Fallback genérico: 50%
        if (!commissionRate) {
          commissionRate = 0.50;
          source = 'default.generic';
        }

        // Calcular valor
        const commissionValue = Math.round(session.sessionValue * commissionRate * 100) / 100;

        if (!isDryRun) {
          await Session.updateOne(
            { _id: session._id },
            { $set: { commissionRate, commissionValue } }
          );
        }

        updated++;
        if (updated % 100 === 0) {
          console.log(`   Progresso: ${updated}/${sessions.length}`);
        }

      } catch (err) {
        skipped++;
        errors.push({ sessionId: session._id, error: err.message });
      }
    }

    console.log(`\n📈 Resumo:`);
    console.log(`   Atualizadas: ${updated}`);
    console.log(`   Ignoradas: ${skipped}`);
    console.log(`   Erros: ${errors.length}`);

    const totalCommission = sessions
      .filter(s => s.commissionValue)
      .reduce((sum, s) => sum + s.commissionValue, 0);
    console.log(`   Comissão total calculada: R$ ${totalCommission.toFixed(2)}`);

    if (isDryRun) {
      console.log(`\n⚠️  DRY RUN - Nenhuma alteração foi salva`);
    }

  } catch (error) {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔚 Conexão fechada');
  }
}

migrate();

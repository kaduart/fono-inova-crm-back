/**
 * 🔄 Migration: Preencher sessionValue para sessões existentes
 * 
 * Estratégia:
 * 1. Sessões de pacote → package.sessionValue ou package.totalValue/totalSessions
 * 2. Sessões avulsas → appointment.serviceValue ou valor padrão da especialidade
 * 3. Sessões de convênio → insuranceGrossAmount do pacote
 * 
 * Uso: node scripts/migrate-session-values.js [--dry-run]
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

// Schemas mínimos
const sessionSchema = new mongoose.Schema({
  package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  sessionValue: Number,
  paymentMethod: String,
  status: String,
  specialty: String
}, { timestamps: true });

const packageSchema = new mongoose.Schema({
  sessionValue: Number,
  totalValue: Number,
  totalSessions: Number,
  insuranceGrossAmount: Number,
  type: String
}, { timestamps: true });

const appointmentSchema = new mongoose.Schema({
  serviceValue: Number,
  insuranceValue: Number,
  specialty: String
}, { timestamps: true });

// Valores padrão por especialidade (fallback)
const DEFAULT_VALUES = {
  'fonoaudiologia': 120,
  'terapia_ocupacional': 130,
  'psicologia': 140,
  'fisioterapia': 110,
  'psicomotricidade': 100,
  'musicoterapia': 125,
  'psicopedagogia': 135,
  'avaliacao': 200
};

async function migrate() {
  console.log(`🔄 Migrando sessionValue ${isDryRun ? '(DRY RUN)' : ''}...\n`);

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const Session = mongoose.model('Session', sessionSchema);
    const Package = mongoose.model('Package', packageSchema);
    const Appointment = mongoose.model('Appointment', appointmentSchema);

    // Buscar sessões sem sessionValue
    const sessions = await Session.find({
      $or: [
        { sessionValue: { $exists: false } },
        { sessionValue: null },
        { sessionValue: 0 }
      ]
    }).limit(1000); // Batch de 1000

    console.log(`📊 Encontradas ${sessions.length} sessões sem sessionValue\n`);

    if (sessions.length === 0) {
      console.log('✅ Nenhuma sessão precisa de atualização');
      return;
    }

    let updated = 0;
    let skipped = 0;
    let errors = [];

    for (const session of sessions) {
      try {
        let sessionValue = null;
        let source = '';

        // 1️⃣ Tentar obter do pacote
        if (session.package) {
          const pkg = await Package.findById(session.package).lean();
          if (pkg) {
            if (pkg.sessionValue && pkg.sessionValue > 0) {
              sessionValue = pkg.sessionValue;
              source = 'package.sessionValue';
            } else if (pkg.insuranceGrossAmount && pkg.insuranceGrossAmount > 0) {
              sessionValue = pkg.insuranceGrossAmount;
              source = 'package.insuranceGrossAmount';
            } else if (pkg.totalValue && pkg.totalSessions && pkg.totalSessions > 0) {
              sessionValue = pkg.totalValue / pkg.totalSessions;
              source = 'package.totalValue/totalSessions';
            }
          }
        }

        // 2️⃣ Tentar obter do appointment
        if (!sessionValue && session.appointmentId) {
          const appt = await Appointment.findById(session.appointmentId).lean();
          if (appt) {
            if (appt.serviceValue && appt.serviceValue > 0) {
              sessionValue = appt.serviceValue;
              source = 'appointment.serviceValue';
            } else if (appt.insuranceValue && appt.insuranceValue > 0) {
              sessionValue = appt.insuranceValue;
              source = 'appointment.insuranceValue';
            }
          }
        }

        // 3️⃣ Fallback: valor padrão da especialidade
        if (!sessionValue) {
          const specialty = session.specialty?.toLowerCase() || '';
          for (const [key, value] of Object.entries(DEFAULT_VALUES)) {
            if (specialty.includes(key)) {
              sessionValue = value;
              source = `default.${key}`;
              break;
            }
          }
        }

        // 4️⃣ Último fallback: 100
        if (!sessionValue) {
          sessionValue = 100;
          source = 'default.generic';
        }

        if (!isDryRun) {
          await Session.updateOne(
            { _id: session._id },
            { $set: { sessionValue } }
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

    if (isDryRun) {
      console.log(`\n⚠️  DRY RUN - Nenhuma alteração foi salva`);
    }

    if (errors.length > 0) {
      console.log(`\n⚠️  Primeiros erros:`);
      errors.slice(0, 5).forEach(e => console.log(`   - ${e.sessionId}: ${e.error}`));
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

/**
 * 🔄 Migration: Preencher sessionConsumed e statusHistory
 * 
 * Estratégia:
 * - completed → sessionConsumed = true
 * - missed → sessionConsumed = true (ou false, depende da política)
 * - canceled → sessionConsumed = false
 * - others → sessionConsumed = false
 * 
 * Uso: node scripts/migrate-session-consumed.js [--dry-run]
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

const sessionSchema = new mongoose.Schema({
  status: String,
  sessionConsumed: Boolean,
  statusHistory: Array,
  updatedAt: Date
}, { timestamps: true });

function shouldConsume(status) {
  // Política: completed consome
  // canceled não consome
  // missed = null (não assumimos política da clínica)
  if (status === 'completed') return true;
  if (status === 'canceled') return false;
  return null; // missed, scheduled, etc = indefinido
}

async function migrate() {
  console.log(`🔄 Migrando sessionConsumed ${isDryRun ? '(DRY RUN)' : ''}...\n`);

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const Session = mongoose.model('Session', sessionSchema);

    // Buscar sessões sem sessionConsumed definido
    const sessions = await Session.find({
      $or: [
        { sessionConsumed: { $exists: false } },
        { sessionConsumed: null }
      ]
    }).limit(2000);

    console.log(`📊 Encontradas ${sessions.length} sessões sem sessionConsumed\n`);

    if (sessions.length === 0) {
      console.log('✅ Nenhuma sessão precisa de atualização');
      return;
    }

    let updated = 0;
    let byStatus = {};

    for (const session of sessions) {
      try {
        const shouldBeConsumed = shouldConsume(session.status);
        
        // Criar statusHistory inicial se não existir
        const statusHistory = session.statusHistory || [{
          status: session.status,
          at: session.updatedAt || new Date()
        }];

        if (!isDryRun) {
          await Session.updateOne(
            { _id: session._id },
            { 
              $set: { 
                sessionConsumed: shouldBeConsumed,
                statusHistory: statusHistory
              } 
            }
          );
        }

        byStatus[session.status] = (byStatus[session.status] || 0) + 1;
        updated++;

        if (updated % 500 === 0) {
          console.log(`   Progresso: ${updated}/${sessions.length}`);
        }

      } catch (err) {
        console.error(`❌ Erro na sessão ${session._id}:`, err.message);
      }
    }

    console.log(`\n📈 Resumo:`);
    console.log(`   Total atualizado: ${updated}`);
    console.log(`   Por status:`);
    Object.entries(byStatus).forEach(([status, count]) => {
      const result = shouldConsume(status);
      const consumed = result === true ? 'consome' : result === false ? 'não consome' : 'indefinido';
      console.log(`     ${status}: ${count} (${consumed})`);
    });

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

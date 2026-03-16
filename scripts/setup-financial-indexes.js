/**
 * 📊 Setup de Índices MongoDB para Financial Metrics
 * 
 * Otimiza queries do financialMetrics.service.js
 * 
 * Uso: node scripts/setup-financial-indexes.js [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado no .env');
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');

const INDEXES = {
  sessions: [
    // Principal: _calculateCashFromSessions
    {
      name: 'idx_session_convenio_cash',
      keys: { paymentMethod: 1, isPaid: 1, paidAt: 1 }
    },
    // Para lookup de package
    {
      name: 'idx_session_package',
      keys: { package: 1 }
    },
    // Para produção
    {
      name: 'idx_session_production',
      keys: { status: 1, date: 1 }
    }
  ],
  payments: [
    // Convênio avulso recebido
    {
      name: 'idx_payment_insurance_received',
      keys: { 'insurance.receivedAt': 1, billingType: 1, 'insurance.status': 1 }
    },
    // Particular recebido
    {
      name: 'idx_payment_particular',
      keys: { date: 1, billingType: 1, status: 1 }
    },
    // Lookup por session (individual)
    {
      name: 'idx_payment_session',
      keys: { session: 1 }
    },
    // Lookup por sessions (batch/lote)
    {
      name: 'idx_payment_sessions_array',
      keys: { sessions: 1 }
    },
    // Convênio faturado
    {
      name: 'idx_payment_insurance_billed',
      keys: { 'insurance.billedAt': 1, billingType: 1, 'insurance.status': 1 }
    }
  ]
};

async function setupIndexes() {
  console.log(`📊 Configurando índices ${isDryRun ? '(DRY RUN)' : ''}...\n`);

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const db = mongoose.connection.db;
    const results = { created: 0, existing: 0, errors: [] };

    for (const [collection, indexes] of Object.entries(INDEXES)) {
      console.log(`📁 Coleção: ${collection}`);

      for (const idx of indexes) {
        try {
          if (isDryRun) {
            console.log(`   ⏭️  [DRY RUN] ${idx.name}: ${JSON.stringify(idx.keys)}`);
            continue;
          }

          await db.collection(collection).createIndex(idx.keys, { 
            name: idx.name,
            background: true  // Não bloqueia operação
          });
          
          console.log(`   ✅ ${idx.name}`);
          results.created++;

        } catch (err) {
          if (err.code === 86) {  // Index already exists
            console.log(`   ℹ️  ${idx.name} (já existe)`);
            results.existing++;
          } else {
            console.error(`   ❌ ${idx.name}: ${err.message}`);
            results.errors.push({ collection, index: idx.name, error: err.message });
          }
        }
      }
      console.log('');
    }

    console.log('\n📈 Resumo:');
    console.log(`   Criados: ${results.created}`);
    console.log(`   Existentes: ${results.existing}`);
    console.log(`   Erros: ${results.errors.length}`);

    if (results.errors.length > 0) {
      console.log('\n⚠️  Erros:');
      results.errors.forEach(e => console.log(`   - ${e.collection}.${e.index}: ${e.error}`));
    }

    // Mostrar estatísticas de uso (opcional)
    console.log('\n🔍 Dica: Para verificar uso dos índices:');
    console.log('   db.sessions.explain("executionStats").aggregate([...])');

  } catch (error) {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔚 Conexão fechada');
  }
}

// Executar
setupIndexes();

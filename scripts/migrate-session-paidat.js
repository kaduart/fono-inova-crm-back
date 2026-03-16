/**
 * 🔄 Migration: Adicionar paidAt em sessões de convênio pacote já pagas
 * 
 * Problema: Sessões marcadas como isPaid=true antes da implementação do campo paidAt
 * não têm data de recebimento, quebrando o cálculo de caixa.
 * 
 * Solução: Para sessões isPaid=true sem paidAt, definir paidAt baseado em:
 * 1. Package.insuranceReceivedAt (se disponível)
 * 2. Package.updatedAt (fallback)
 * 3. Session.updatedAt (último recurso)
 * 
 * 🛡️ PROTEÇÕES:
 * - Só atualiza se paymentId = null (não vinculada a Payment)
 * - Verifica se não existe Payment vinculado por session ou sessions array
 * - Só processa paymentMethod = 'convenio'
 * 
 * Uso: node scripts/migrate-session-paidat.js [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carregar variáveis de ambiente (script está em back/scripts/)
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado no .env');
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');

// Schema mínimo para migration
const sessionSchema = new mongoose.Schema({
  isPaid: Boolean,
  paidAt: Date,
  paymentMethod: String,
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
  updatedAt: Date
}, { timestamps: true });

const packageSchema = new mongoose.Schema({
  insuranceReceivedAt: Date,
  insuranceBillingStatus: String,
  updatedAt: Date
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
  status: String,
  createdAt: Date
}, { timestamps: true });

async function hasLinkedPayment(sessionId, Payment) {
  // Verifica se existe Payment vinculado de qualquer forma
  const payment = await Payment.findOne({
    $or: [
      { session: sessionId },
      { sessions: sessionId }
    ]
  }).lean();
  
  return !!payment;
}

async function migrate() {
  console.log(`🔄 Iniciando migration ${isDryRun ? '(DRY RUN)' : ''}...\n`);

  try {
    // Conectar ao MongoDB
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const Session = mongoose.model('Session', sessionSchema);
    const Package = mongoose.model('Package', packageSchema);
    const Payment = mongoose.model('Payment', paymentSchema);

    // Buscar sessões de convênio pagas sem paidAt
    const sessions = await Session.find({
      isPaid: true,
      $or: [
        { paidAt: { $exists: false } },
        { paidAt: null }
      ],
      paymentMethod: 'convenio',
      $or: [
        { paymentId: { $exists: false } },
        { paymentId: null }
      ]
    }).lean();

    console.log(`📊 Encontradas ${sessions.length} sessões candidatas (pré-filtro Payment)\n`);

    if (sessions.length === 0) {
      console.log('✅ Nenhuma sessão precisa de atualização');
      return;
    }

    let updated = 0;
    let skipped = 0;
    let hasPayment = 0;
    const errors = [];

    for (const session of sessions) {
      try {
        // 🛡️ PROTEÇÃO: Verificar se existe Payment vinculado
        const paymentExists = await hasLinkedPayment(session._id, Payment);
        
        if (paymentExists) {
          hasPayment++;
          console.log(`⏭️  Sessão ${session._id}: ignorada (possui Payment vinculado)`);
          continue;
        }

        let paidAt = null;
        let source = '';

        // Buscar pacote associado
        const pkg = session.package ? await Package.findById(session.package).lean() : null;

        // 🛡️ SÓ usamos datas precisas de recebimento
        // NUNCA usamos updatedAt (pode ser edição posterior)
        if (pkg?.insuranceReceivedAt) {
          paidAt = pkg.insuranceReceivedAt;
          source = 'package.insuranceReceivedAt';
        } else if (pkg?.createdAt) {
          // Fallback aceitável: data de criação do pacote
          // (geralmente próxima da data do pagamento)
          paidAt = pkg.createdAt;
          source = 'package.createdAt (fallback)';
        }
        // 🚫 NÃO usamos updatedAt (pode ser edição futura)
        // 🚫 NÃO usamos session.updatedAt

        if (!paidAt) {
          skipped++;
          console.log(`⚠️  Sessão ${session._id}: ignorada (sem data de recebimento precisa)`);
          continue;
        }

        if (!isDryRun) {
          await Session.updateOne(
            { _id: session._id },
            { $set: { paidAt } }
          );
        }

        updated++;
        console.log(`✅ Sessão ${session._id}: paidAt = ${paidAt.toISOString()} (${source})`);

      } catch (err) {
        skipped++;
        errors.push({ sessionId: session._id, error: err.message });
        console.error(`❌ Erro na sessão ${session._id}:`, err.message);
      }
    }

    console.log(`\n📈 Resumo:`);
    console.log(`   Atualizadas: ${updated}`);
    console.log(`   Com Payment (ignoradas): ${hasPayment}`);
    console.log(`   Sem data (ignoradas): ${skipped}`);
    console.log(`   Erros: ${errors.length}`);
    console.log(`   Total candidatas: ${sessions.length}`);

    if (isDryRun) {
      console.log(`\n⚠️  DRY RUN - Nenhuma alteração foi salva`);
    }

    if (errors.length > 0) {
      console.log(`\n⚠️  Erros (${errors.length}):`);
      errors.forEach(e => console.log(`   - ${e.sessionId}: ${e.error}`));
    }

  } catch (error) {
    console.error('❌ Erro fatal na migration:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔚 Conexão fechada');
  }
}

// Executar
migrate();

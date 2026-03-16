/**
 * 📊 Relatório de Impacto Pre-Migração
 * 
 * Analisa dados existentes antes de rodar migrations.
 * Mostra quantidade de registros afetados e potenciais problemas.
 * 
 * Uso: node scripts/migration-impact-report.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI;

const sessionSchema = new mongoose.Schema({
  status: String,
  paymentMethod: String,
  sessionValue: Number,
  commissionRate: Number,
  commissionValue: Number,
  paidAt: Date,
  sessionConsumed: Boolean,
  isPaid: Boolean
}, { timestamps: true });

async function generateReport() {
  console.log('📊 Relatório de Impacto Pre-Migração\n');
  console.log('=' .repeat(60));

  try {
    await mongoose.connect(MONGO_URI);
    const Session = mongoose.model('Session', sessionSchema);

    // 1️⃣ Total de sessões
    const totalSessions = await Session.countDocuments();
    console.log(`\n📁 Total de sessões: ${totalSessions}`);

    // 2️⃣ Por status
    console.log('\n📊 Por status:');
    const byStatus = await Session.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    byStatus.forEach(s => {
      const pct = ((s.count / totalSessions) * 100).toFixed(1);
      console.log(`   ${s._id || 'null'}: ${s.count} (${pct}%)`);
    });

    // 3️⃣ Por paymentMethod
    console.log('\n💳 Por método de pagamento:');
    const byMethod = await Session.aggregate([
      { $group: { _id: '$paymentMethod', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    byMethod.forEach(m => {
      const pct = ((m.count / totalSessions) * 100).toFixed(1);
      console.log(`   ${m._id || 'null'}: ${m.count} (${pct}%)`);
    });

    // 4️⃣ Sessões sem sessionValue
    const noValue = await Session.countDocuments({
      $or: [
        { sessionValue: { $exists: false } },
        { sessionValue: null },
        { sessionValue: 0 }
      ]
    });
    console.log(`\n💰 Sessões sem sessionValue: ${noValue} (${((noValue/totalSessions)*100).toFixed(1)}%)`);

    // 5️⃣ Sessões sem commissionValue
    const noCommission = await Session.countDocuments({
      status: 'completed',
      $or: [
        { commissionValue: { $exists: false } },
        { commissionValue: null }
      ]
    });
    console.log(`👨‍⚕️ Sessões completed sem comissão: ${noCommission}`);

    // 6️⃣ Sessões sem sessionConsumed
    const noConsumed = await Session.countDocuments({
      $or: [
        { sessionConsumed: { $exists: false } },
        { sessionConsumed: null }
      ]
    });
    console.log(`📦 Sessões sem sessionConsumed: ${noConsumed} (${((noConsumed/totalSessions)*100).toFixed(1)}%)`);

    // 7️⃣ Convênio pacote sem paidAt
    const convenioNoPaidAt = await Session.countDocuments({
      paymentMethod: 'convenio',
      isPaid: true,
      $or: [
        { paidAt: { $exists: false } },
        { paidAt: null }
      ]
    });
    console.log(`🏥 Convênio pago sem paidAt: ${convenioNoPaidAt}`);

    // 8️⃣ Sessões 'missed' (política indefinida)
    const missedCount = await Session.countDocuments({ status: 'missed' });
    console.log(`\n⚠️  Sessões 'missed' (política a definir): ${missedCount}`);
    console.log('   Estas terão sessionConsumed = null na migration');

    // 9️⃣ Estimativa de impacto
    console.log('\n' + '='.repeat(60));
    console.log('📈 Estimativa de registros afetados:');
    console.log(`   session-values: ${noValue} sessões`);
    console.log(`   commissions: ${noCommission} sessões`);
    console.log(`   session-consumed: ${noConsumed} sessões`);
    console.log(`   paidat: ${convenioNoPaidAt} sessões`);

    // 🔟 Riscos identificados
    console.log('\n⚠️  Potenciais problemas:');
    if (noValue > totalSessions * 0.5) {
      console.log('   🚨 ALTO: Mais de 50% das sessões sem valor!');
      console.log('      Verificar se valor default está adequado.');
    }
    if (missedCount > 100) {
      console.log('   ⚠️  Médio: Muitas sessões missed.');
      console.log('      Definir política: falta consome ou não?');
    }
    if (convenioNoPaidAt > 50) {
      console.log('   ⚠️  Médio: Convênios pagos sem data de pagamento.');
      console.log('      Verificar packages com insuranceReceivedAt.');
    }

    console.log('\n✅ Próximo passo: rodar migrations');
    console.log('   node scripts/migrate-all-financial.js --dry-run');

  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

generateReport();

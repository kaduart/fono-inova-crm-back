#!/usr/bin/env node
/**
 * 🔄 Backfill — Package.sequenceNumber
 *
 * Preenche o identificador amigável (sequencial por paciente+especialidade,
 * ex: 3º pacote de fono de um paciente = sequenceNumber 3) para pacotes
 * criados antes do campo existir. Pacotes novos já recebem o valor na
 * criação (packageController.v2.js).
 *
 * Ordena por `date` (fallback `createdAt`) dentro de cada grupo
 * paciente+sessionType e numera 1, 2, 3... na ordem cronológica real —
 * a mesma ordem que apareceria numa conversa humana sobre "qual pacote".
 *
 * Modo dry-run por padrão. Use --apply para persistir.
 *
 * Uso:
 *   node scripts/migrations/backfill-package-sequence-number.js
 *   node scripts/migrations/backfill-package-sequence-number.js --apply
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function run() {
  console.log(`🔄 Backfill — Package.sequenceNumber`);
  console.log(`   Modo: ${APPLY ? 'APLICAÇÃO REAL' : 'DRY-RUN'}`);
  console.log();

  console.time('⏱️ Tempo de execução');
  await mongoose.connect(MONGO_URI);

  const Package = mongoose.connection.db.collection('packages');
  // 🚨 IMPORTANTE (ADR-014, DOMAIN_INVARIANTS.md): GET /v2/packages e
  // GET /v2/packages/:id (as rotas reais usadas pelo frontend, ver
  // routes/package.v2.js) leem exclusivamente de `packages_view` — nunca de
  // `packages` direto. Sem espelhar aqui, sequenceNumber gravaria certo no
  // write model e nunca apareceria na tela, mesmo bug já documentado quando
  // frequencyInterval foi adicionado (2026-08-06). Update pontual só neste
  // campo — não recalcula mais nada da view.
  const PackagesView = mongoose.connection.db.collection('packages_view');

  // Só pacotes sem sequenceNumber ainda (idempotente — rodar de novo não reprocessa)
  const packages = await Package.find({
    $or: [{ sequenceNumber: { $exists: false } }, { sequenceNumber: null }]
  })
    .project({ _id: 1, patient: 1, sessionType: 1, specialty: 1, date: 1, createdAt: 1 })
    .toArray();

  console.log(`📦 ${packages.length} pacotes sem sequenceNumber`);

  const groups = new Map();
  for (const pkg of packages) {
    const patientId = pkg.patient?.toString();
    const sessionType = pkg.sessionType || pkg.specialty;
    if (!patientId || !sessionType) {
      console.warn(`⚠️ Pacote ${pkg._id} sem patient ou sessionType/specialty — pulado`);
      continue;
    }
    const key = `${patientId}::${sessionType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pkg);
  }

  console.log(`👥 ${groups.size} grupos (paciente+especialidade)`);

  let updated = 0;
  const details = [];

  for (const [key, group] of groups) {
    group.sort((a, b) => {
      const dateA = new Date(a.date || a.createdAt).getTime();
      const dateB = new Date(b.date || b.createdAt).getTime();
      return dateA - dateB;
    });

    for (let i = 0; i < group.length; i++) {
      const pkg = group[i];
      const sequenceNumber = i + 1;
      details.push({ packageId: pkg._id.toString(), key, sequenceNumber });

      if (APPLY) {
        await Package.updateOne({ _id: pkg._id }, { $set: { sequenceNumber } });
        await PackagesView.updateOne({ packageId: pkg._id }, { $set: { sequenceNumber } });
      }
      updated++;
    }
  }

  await mongoose.disconnect();
  console.timeEnd('⏱️ Tempo de execução');

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RESUMO DO BACKFILL — sequenceNumber                          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`Pacotes processados: ${updated}`);
  console.log(`Grupos:              ${groups.size}`);
  console.log(`Modo:                ${APPLY ? 'apply' : 'dry-run'}`);

  if (!APPLY && updated > 0) {
    console.log(`\n⚠️  DRY-RUN: nenhuma alteração foi persistida.`);
    console.log(`    Rode com --apply para executar o backfill.`);
  }

  console.log(`\n📝 Primeiras atribuições previstas:`);
  for (const d of details.slice(0, 15)) {
    console.log(`  ${d.packageId} (${d.key}) → sequenceNumber=${d.sequenceNumber}`);
  }
  if (details.length > 15) {
    console.log(`  ... e mais ${details.length - 15}`);
  }
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});

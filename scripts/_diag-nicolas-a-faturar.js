#!/usr/bin/env node
/**
 * Diagnóstico específico: Nicolas Lucca na listagem "A Faturar" (maio/2026).
 *
 * Chama o adapter real e mostra o que retorna.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('Mongo URI não configurado');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado');

  const Patient = (await import('../models/Patient.js')).default;
  const { listGuidesPendingBilling } = (await import('../services/insuranceBatchGuideAdapter.js'));

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id fullName').lean();
  if (!patient) {
    console.log('Nicolas Lucca não encontrado');
    return;
  }

  console.log(`Paciente: ${patient.fullName} (${patient._id})`);

  // Sem filtro de mês: usa o cutoff padrão (março/2026 agora)
  const defaultResult = await listGuidesPendingBilling({
    patientId: patient._id.toString(),
    limit: 100
  });

  console.log(`\n[A Faturar] Sem filtro de mês (cutoff padrão março/2026):`);
  console.log(`  Total de guias: ${defaultResult.total}`);
  console.log(`  Sessões órfãs: ${defaultResult.orphanSessions.length}`);
  for (const g of defaultResult.guides) {
    console.log(`  Guia ${g.number || g.guideId} (${g.insurance}): ${g.sessions?.length || 0} sessões`);
    if (g.sessions?.length) {
      for (const s of g.sessions) {
        console.log(`    ${new Date(s.date).toISOString().slice(0,10)} | ${s.specialty} | ${s.value}`);
      }
    }
  }

  // Com filtro maio/2026
  const mayResult = await listGuidesPendingBilling({
    patientId: patient._id.toString(),
    month: '2026-05',
    limit: 100
  });

  console.log(`\n[A Faturar] Mês maio/2026:`);
  console.log(`  Total de guias: ${mayResult.total}`);
  console.log(`  Sessões órfãs: ${mayResult.orphanSessions.length}`);
  for (const g of mayResult.guides) {
    console.log(`  Guia ${g.number || g.guideId} (${g.insurance}): ${g.sessions?.length || 0} sessões`);
    if (g.sessions?.length) {
      for (const s of g.sessions) {
        console.log(`    ${new Date(s.date).toISOString().slice(0,10)} | ${s.specialty} | ${s.value}`);
      }
    }
  }

  await mongoose.disconnect();
  console.log('\nDesconectado');
}

main().catch(e => { console.error(e); process.exit(1); });

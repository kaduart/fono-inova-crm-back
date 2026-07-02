#!/usr/bin/env node
/**
 * Deleção segura de guias órfãs identificadas como teste.
 *
 * Uso:
 *   node scripts/delete-test-orphan-guides.js           # apenas lista (dry-run implícito)
 *   node scripts/delete-test-orphan-guides.js --confirm # executa a deleção
 *
 * Critérios específicos (nunca deleta por código de convênio genérico):
 *   - unimed: patientId do paciente AAAA
 *   - amil: patientIds dos pacientes de teste + números específicos
 *   - hapvida: patientId Paciente Liminar Demo + número específico
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isConfirm = process.argv.includes('--confirm');

const oid = (id) => new mongoose.Types.ObjectId(id);

const CRITERIA = {
  unimed: {
    insurance: 'unimed',
    patientId: oid('69d94c390701eba04b58d4cc') // paciente AAAA
  },
  amil: {
    insurance: 'amil',
    $or: [
      { patientId: oid('69dd3853091fb7cb471c20b4') }, // Paciente Liminar Demo
      { patientId: oid('6a046dfa0e8ce6c05b43f6f8') }, // paciente não encontrado
      { patientId: oid('6a285b1dc80613b545215b61') }, // ana teste 2
      { number: { $in: ['16007195888', '232323', '262662', '22221'] } }
    ]
  },
  hapvida: {
    insurance: 'hapvida',
    patientId: oid('69dd3853091fb7cb471c20b4'), // Paciente Liminar Demo
    number: '6333'
  }
};

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI ou MONGO_URI não configurado no .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado ao MongoDB');

  const db = mongoose.connection.db;

  try {
    const allGuides = [];

    for (const [label, criteria] of Object.entries(CRITERIA)) {
      const guides = await db.collection('insuranceguides')
        .find(criteria)
        .project({ number: 1, patientId: 1, specialty: 1, status: 1, totalSessions: 1, usedSessions: 1, expiresAt: 1 })
        .toArray();

      allGuides.push(...guides.map(g => ({ ...g, _source: label })));
    }

    console.log('\n=== Guias identificadas para remoção ===');
    console.log(`Total: ${allGuides.length}\n`);

    for (const g of allGuides) {
      console.log(`[${g._source}]`);
      console.log(`  ID:    ${g._id}`);
      console.log(`  Número: ${g.number}`);
      console.log(`  PatientId: ${g.patientId}`);
      console.log(`  Especialidade: ${g.specialty}`);
      console.log(`  Status: ${g.status}`);
      console.log(`  Total/Usado: ${g.totalSessions}/${g.usedSessions}`);
      console.log(`  Expira em: ${g.expiresAt ? new Date(g.expiresAt).toISOString() : 'N/A'}`);
      console.log('');
    }

    if (!isConfirm) {
      console.log('>>> MODO DRY-RUN: nenhuma guia foi removida <<<');
      console.log('Para executar a remoção, rode com --confirm');
      return;
    }

    if (allGuides.length === 0) {
      console.log('Nenhuma guia encontrada. Nada a remover.');
      return;
    }

    const idsToDelete = allGuides.map(g => g._id);

    console.log('\n>>> EXECUTANDO REMOÇÃO <<<');
    const result = await db.collection('insuranceguides').deleteMany({
      _id: { $in: idsToDelete }
    });

    console.log(`Guias removidas: ${result.deletedCount}`);

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

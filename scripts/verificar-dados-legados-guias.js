#!/usr/bin/env node
/**
 * Verifica dados legados de guias e convênios antes/depois da migração lifecycle.
 *
 * Uso:
 *   node scripts/verificar-dados-legados-guias.js
 *
 * Saída:
 *   - Convênios sem guidePolicy
 *   - Convênios com renewalType fora do enum válido
 *   - Quantidade de guias afetadas por convênio sem política
 *   - Guias sem campo insurance ou com insurance inexistente
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const VALID_RENEWAL_TYPES = ['end_of_month', 'until_consumed', 'fixed_date', 'authorization_validity'];

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
    // 1. Convênios sem guidePolicy
    const conveniosSemPolicy = await db.collection('convenios').find({
      $or: [
        { guidePolicy: { $exists: false } },
        { guidePolicy: null }
      ]
    }).project({ code: 1, name: 1, guidePolicy: 1 }).toArray();

    console.log('\n=== Convênios sem guidePolicy ===');
    console.log(`Total: ${conveniosSemPolicy.length}`);
    for (const c of conveniosSemPolicy) {
      console.log(`  - ${c.code} (${c.name || 'sem nome'})`);
    }

    // 2. Convênios com renewalType inválido
    const conveniosRenewalInvalido = await db.collection('convenios').find({
      'guidePolicy.renewalType': { $nin: [...VALID_RENEWAL_TYPES, null, undefined] }
    }).project({ code: 1, name: 1, 'guidePolicy.renewalType': 1 }).toArray();

    console.log('\n=== Convênios com renewalType fora do enum ===');
    console.log(`Total: ${conveniosRenewalInvalido.length}`);
    for (const c of conveniosRenewalInvalido) {
      console.log(`  - ${c.code}: ${c.guidePolicy?.renewalType}`);
    }

    // 3. Guias afetadas por convênios sem política
    if (conveniosSemPolicy.length > 0) {
      const codesSemPolicy = conveniosSemPolicy.map(c => c.code);
      const guiasSemPolicy = await db.collection('insuranceguides').countDocuments({
        insurance: { $in: codesSemPolicy }
      });

      console.log('\n=== Guias vinculadas a convênios sem guidePolicy ===');
      console.log(`Total de guias: ${guiasSemPolicy}`);

      const porConvenio = await db.collection('insuranceguides').aggregate([
        { $match: { insurance: { $in: codesSemPolicy } } },
        { $group: { _id: '$insurance', count: { $sum: 1 } } }
      ]).toArray();

      for (const item of porConvenio) {
        console.log(`  - ${item._id}: ${item.count} guias`);
      }
    }

    // 4. Guias sem insurance ou com insurance vazio
    const guiasSemInsurance = await db.collection('insuranceguides').countDocuments({
      $or: [
        { insurance: { $exists: false } },
        { insurance: null },
        { insurance: '' }
      ]
    });

    console.log('\n=== Guias sem campo insurance ===');
    console.log(`Total: ${guiasSemInsurance}`);

    // 5. Convênios existentes no enum mas não cadastrados
    const conveniosCadastrados = await db.collection('convenios').distinct('code');
    const insuranceDasGuias = await db.collection('insuranceguides').distinct('insurance');
    const insuranceNaoCadastrados = insuranceDasGuias.filter(
      i => i && !conveniosCadastrados.includes(i)
    );

    console.log('\n=== Códigos de insurance em guias sem convênio cadastrado ===');
    console.log(`Total: ${insuranceNaoCadastrados.length}`);
    for (const code of insuranceNaoCadastrados) {
      const count = await db.collection('insuranceguides').countDocuments({ insurance: code });
      console.log(`  - ${code}: ${count} guias`);
    }

    console.log('\n=== Resumo ===');
    console.log(`Convênios sem guidePolicy: ${conveniosSemPolicy.length}`);
    console.log(`Convênios com renewalType inválido: ${conveniosRenewalInvalido.length}`);
    console.log(`Guias sem insurance: ${guiasSemInsurance}`);
    console.log(`Insurance em guias sem convênio: ${insuranceNaoCadastrados.length}`);

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

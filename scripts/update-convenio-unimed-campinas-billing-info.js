#!/usr/bin/env node
/**
 * Preenche e-mail de faturamento, prazo de emissão e dados fiscais do convênio unimed-campinas.
 *
 * Uso:
 *   node scripts/update-convenio-unimed-campinas-billing-info.js           # dry-run
 *   node scripts/update-convenio-unimed-campinas-billing-info.js --confirm # aplica
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isConfirm = process.argv.includes('--confirm');

const NOVOS_DADOS = {
  legalName: 'Unimed Campinas Cooperativa de Trabalho Médico',
  taxId: '46.124.624/0001-11',
  guidePolicy: {
    billingEmail: 'pagamento.prestadores@unimedcampinas.com.br',
    billingDeadlineDays: 30
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
    const convenio = await db.collection('convenios').findOne({ code: 'unimed-campinas' });

    if (!convenio) {
      console.log('Convênio unimed-campinas não encontrado.');
      return;
    }

    const novoGuidePolicy = { ...(convenio.guidePolicy || {}), ...NOVOS_DADOS.guidePolicy };

    console.log('Convênio encontrado:');
    console.log(`  Código: ${convenio.code}`);
    console.log(`  Nome: ${convenio.name}`);
    console.log(`  legalName atual: ${convenio.legalName || '(vazio)'}`);
    console.log(`  taxId atual: ${convenio.taxId || '(vazio)'}`);
    console.log(`  guidePolicy atual: ${JSON.stringify(convenio.guidePolicy)}`);
    console.log('---');
    console.log(`  legalName novo: ${NOVOS_DADOS.legalName}`);
    console.log(`  taxId novo: ${NOVOS_DADOS.taxId}`);
    console.log(`  guidePolicy novo: ${JSON.stringify(novoGuidePolicy)}`);

    if (!isConfirm) {
      console.log('\n>>> MODO DRY-RUN: nenhuma alteração aplicada <<<');
      console.log('Para aplicar, rode com --confirm');
      return;
    }

    await db.collection('convenios').updateOne(
      { _id: convenio._id },
      {
        $set: {
          legalName: NOVOS_DADOS.legalName,
          taxId: NOVOS_DADOS.taxId,
          guidePolicy: novoGuidePolicy,
          updatedAt: new Date()
        }
      }
    );

    console.log('\n✅ Unimed Campinas atualizada com sucesso.');

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

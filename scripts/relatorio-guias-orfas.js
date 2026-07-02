#!/usr/bin/env node
/**
 * Relatório de guias com insurance não cadastrado (códigos órfãos).
 *
 * Uso:
 *   node scripts/relatorio-guias-orfas.js
 *
 * Saída: relatório em TXT com dados do paciente, guia, código armazenado
 * e sugestão de mapeamento. Não altera dados.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Configure aqui o mapeamento de códigos órfãos para convênios existentes.
 * Deixe vazio para apenas listar os casos sem sugestão.
 *
 * Exemplo:
 * const MAPEAMENTO_SUGERIDO = {
 *   'unimed': 'unimed-anapolis',
 *   'amil': 'amil',
 *   'hapvida': 'hapvida'
 * };
 */
const MAPEAMENTO_SUGERIDO = {
  // 'unimed': 'unimed-anapolis',
  // 'amil': 'amil',
  // 'hapvida': 'hapvida'
};

/**
 * Políticas padrão para novos convênios que precisem ser criados.
 */
const POLITICA_PADRAO_NOVO_CONVENIO = {
  renewalType: 'end_of_month',
  renewalDay: 'last_day',
  expirationWarningDays: 5,
  autoSuggestRenewal: true,
  defaultMigrationStrategy: 'eligible'
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
    const conveniosCadastrados = await db.collection('convenios').find({}).toArray();
    const mapaConvenios = new Map(conveniosCadastrados.map(c => [c.code, c]));
    const codigosCadastrados = new Set(conveniosCadastrados.map(c => c.code));

    const guiasOrfas = await db.collection('insuranceguides').aggregate([
      {
        $match: {
          insurance: { $nin: [...codigosCadastrados, null, ''] }
        }
      },
      {
        $addFields: {
          patientObjectId: {
            $cond: {
              if: { $eq: [{ $type: '$patientId' }, 'string'] },
              then: { $toObjectId: '$patientId' },
              else: '$patientId'
            }
          }
        }
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patientObjectId',
          foreignField: '_id',
          as: 'patient'
        }
      },
      { $unwind: { path: '$patient', preserveNullAndEmptyArrays: true } }
    ]).toArray();

    const porInsurance = {};
    for (const g of guiasOrfas) {
      const code = g.insurance;
      if (!porInsurance[code]) porInsurance[code] = [];
      porInsurance[code].push(g);
    }

    let relatorio = '';
    relatorio += '=====================================================\n';
    relatorio += 'RELATÓRIO DE GUIAS COM INSURANCE NÃO CADASTRADO\n';
    relatorio += '=====================================================\n';
    relatorio += `Gerado em: ${new Date().toISOString()}\n`;
    relatorio += `Total de guias órfãs: ${guiasOrfas.length}\n\n`;

    for (const [code, guias] of Object.entries(porInsurance)) {
      const mapeamento = MAPEAMENTO_SUGERIDO[code];
      const convenioDestino = mapeamento ? mapaConvenios.get(mapeamento) : null;
      const politicaAplicada = convenioDestino?.guidePolicy
        || (mapeamento && !convenioDestino ? POLITICA_PADRAO_NOVO_CONVENIO : null);

      relatorio += `-----------------------------------------------------\n`;
      relatorio += `CÓDIGO ÓRFÃO: ${code}\n`;
      relatorio += `Quantidade de guias: ${guias.length}\n`;
      relatorio += `Mapeamento sugerido: ${mapeamento || '(não configurado)' }\n`;
      relatorio += `Convênio destino existe: ${convenioDestino ? 'SIM' : (mapeamento ? 'NÃO - será criado' : 'N/A')}\n`;
      relatorio += `Política a aplicar: ${politicaAplicada ? JSON.stringify(politicaAplicada) : 'N/A'}\n`;
      relatorio += `\nGuias:\n`;

      for (const g of guias) {
        relatorio += `  - Guia ID: ${g._id}\n`;
        relatorio += `    Número: ${g.number || '(sem número)'}\n`;
        relatorio += `    Paciente: ${g.patient?.fullName || '(não encontrado)'}\n`;
        relatorio += `    PatientId: ${g.patientId}\n`;
        relatorio += `    Especialidade: ${g.specialty}\n`;
        relatorio += `    Status: ${g.status}\n`;
        relatorio += `    Total/Usado: ${g.totalSessions}/${g.usedSessions}\n`;
        relatorio += `    Expira em: ${g.expiresAt ? new Date(g.expiresAt).toISOString() : '(sem data)'}\n`;
        relatorio += `\n`;
      }
    }

    relatorio += `-----------------------------------------------------\n`;
    relatorio += `Convênios cadastrados no sistema:\n`;
    for (const c of conveniosCadastrados) {
      const temPolicy = c.guidePolicy ? 'SIM' : 'NÃO';
      relatorio += `  - ${c.code}: guidePolicy=${temPolicy}\n`;
    }

    const outputPath = path.resolve(__dirname, `../../auditoria-output/relatorio-guias-orfas-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, relatorio);

    console.log(relatorio);
    console.log(`\nRelatório salvo em: ${outputPath}`);

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

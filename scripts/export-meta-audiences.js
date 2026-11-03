#!/usr/bin/env node
/**
 * 📤 Export de público para o Meta (exclusão + seed de lookalike)
 *
 * SOMENTE LEITURA do banco. Gera um CSV com telefone, e-mail e primeiro nome
 * dos pacientes — para (1) EXCLUIR quem já é paciente das campanhas de aquisição
 * e (2) servir de SEED para o lookalike de quem fecha.
 *
 * LGPD: exporta apenas telefone, e-mail e primeiro nome. NUNCA CID, diagnóstico,
 * histórico ou qualquer dado clínico. Telefone normalizado para 55+DDD+número.
 *
 * Conexão: usa PROD_URI_READONLY (conexão read-only de produção). Como é só leitura,
 * é a URI ideal. --db só se a URI não trouxer o nome do banco.
 *
 * Uso:
 *   node scripts/export-meta-audiences.js                      # usa PROD_URI_READONLY
 *   node scripts/export-meta-audiences.js --db=<nome_do_banco> # força o banco, se preciso
 *   node scripts/export-meta-audiences.js --out=./meta-clientes.csv
 *
 * Saída (default): ./meta-clientes-<YYYY-MM-DD>.csv  — colunas: phone,email,first_name
 * É só subir esse CSV no Gerenciador (o Meta faz o hash) ou me mandar que eu subo por API.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import { normalizeE164BR } from '../utils/phone.js';

dotenv.config();
const TAG = '[ExportMeta]';
const log = (...a) => console.log(`${TAG}[${new Date().toISOString()}]`, ...a);

const args = process.argv.slice(2);
const DB_NAME = args.find((a) => a.startsWith('--db='))?.split('=')[1];
const OUT = args.find((a) => a.startsWith('--out='))?.split('=')[1]
  || `./meta-clientes-${new Date().toISOString().slice(0, 10)}.csv`;

// Export é SÓ LEITURA → prioriza a URI read-only de produção.
const MONGO_URI = process.env.PROD_URI_READONLY || process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error(`${TAG} ❌ Defina PROD_URI_READONLY (ou MONGO_URI)`); process.exit(1); }

const isRealBRPhone = (p) => /^55\d{10,11}$/.test(String(p || ''));
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function main() {
  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 3, serverSelectionTimeoutMS: 30_000, ...(DB_NAME && { dbName: DB_NAME }),
  });
  log(`✅ MongoDB conectado — banco: ${mongoose.connection.name}`);

  const patients = await Patient.find({ phone: { $exists: true, $ne: null } })
    .select('fullName phone email').lean();
  log(`Pacientes lidos: ${patients.length}`);

  const seen = new Set();
  const rows = [];
  let semTelefone = 0;

  for (const p of patients) {
    const phone = normalizeE164BR(p.phone);
    if (!isRealBRPhone(phone)) { semTelefone++; continue; }
    if (seen.has(phone)) continue;        // dedupe por telefone
    seen.add(phone);
    rows.push([phone, (p.email || '').trim().toLowerCase(), firstName(p.fullName)]);
  }

  const csv = ['phone,email,first_name', ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
  fs.writeFileSync(path.resolve(process.cwd(), OUT), csv, 'utf8');

  log(`📄 CSV gerado: ${OUT}`);
  log(`   ✅ ${rows.length} contatos únicos | ⚠️ ${semTelefone} sem telefone válido (ignorados)`);
  log('   Use este CSV como EXCLUSÃO e como SEED do lookalike.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`${TAG} ❌`, err.message);
  try { await mongoose.disconnect(); } catch { /* ignora */ }
  process.exit(1);
});

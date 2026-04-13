/**
 * 🔧 MIGRAÇÃO: Adicionar campo 'model' aos pacotes V1 antigos
 * 
 * ISSUE: Pacotes criados antes da V2 não têm o campo 'model' obrigatório,
 *        causando erro PACKAGE_V2_INCOMPATIBLE ao completar sessões.
 * 
 * SOLUÇÃO: Inferir o modelo correto baseado nos campos existentes (type, paymentType)
 * 
 * EXECUTAR COM CUIDADO:
 *   1. node scripts/migrate-packages-v2-model.js --dry-run  (ver o que vai mudar)
 *   2. node scripts/migrate-packages-v2-model.js --audit    (salvar backup)
 *   3. node scripts/migrate-packages-v2-model.js            (aplicar migração)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';


const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../.env');
console.log('📁 Carregando .env de:', envPath);
dotenv.config({ path: envPath });
console.log('🔗 MONGO_URI:', process.env.MONGO_URI ? 'Encontrado ✅' : 'NÃO encontrado ❌');



// Conectar ao MongoDB
async function connectDB() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova';
  await mongoose.connect(uri);
  console.log('✅ Conectado ao MongoDB');
}

// Buscar pacotes sem o campo model
async function findPackagesWithoutModel() {
  const db = mongoose.connection.db;
  const packages = await db.collection('packages').find({
    model: { $exists: false }
  }).toArray();
  
  return packages;
}

// Inferir o model baseado nos campos existentes
function inferModel(pkg) {
  // 1. Liminar (type = 'liminar' ou 'legal')
  if (pkg.type === 'liminar' || pkg.type === 'legal') {
    return 'liminar';
  }
  
  // 2. Convênio (type = 'convenio' ou 'insurance')
  if (pkg.type === 'convenio' || pkg.type === 'insurance') {
    return 'convenio';
  }
  
  // 3. Pré-pago (paymentType = 'full' ou tem totalPaid >= totalValue)
  if (pkg.paymentType === 'full') {
    return 'prepaid';
  }
  
  // 4. Por sessão (paymentType = 'per-session' ou padrão)
  if (pkg.paymentType === 'per-session' || pkg.paymentType === 'per_session') {
    return 'per_session';
  }
  
  // 5. Fallback: se tem pagamentos que cobrem o total = prepaid
  const totalPaid = pkg.totalPaid || 0;
  const totalValue = pkg.totalValue || 0;
  if (totalPaid >= totalValue && totalValue > 0) {
    return 'prepaid';
  }
  
  // 6. Default: per_session (mais seguro - não assume pagamento)
  return 'per_session';
}

// Categorizar pacotes para migração
function categorizePackages(packages) {
  const categories = {
    liminar: [],
    convenio: [],
    prepaid: [],
    per_session: [],
    uncertain: []
  };
  
  for (const pkg of packages) {
    const model = inferModel(pkg);
    const info = {
      _id: pkg._id.toString(),
      type: pkg.type,
      paymentType: pkg.paymentType,
      totalValue: pkg.totalValue,
      totalPaid: pkg.totalPaid,
      inferredModel: model,
      createdAt: pkg.createdAt
    };
    
    categories[model].push(info);
  }
  
  return categories;
}

// Aplicar migração
async function applyMigration(categories, dryRun = false) {
  const db = mongoose.connection.db;
  const results = {
    liminar: { updated: 0, ids: [] },
    convenio: { updated: 0, ids: [] },
    prepaid: { updated: 0, ids: [] },
    per_session: { updated: 0, ids: [] }
  };
  
  for (const [model, packages] of Object.entries(categories)) {
    if (packages.length === 0) continue;
    
    const ids = packages.map(p => new mongoose.Types.ObjectId(p._id));
    
    if (!dryRun) {
      const result = await db.collection('packages').updateMany(
        { _id: { $in: ids } },
        { 
          $set: { 
            model: model,
            '_migration.v2_model_applied_at': new Date(),
            '_migration.v2_model_inferred_from': 'type/paymentType fallback'
          }
        }
      );
      results[model].updated = result.modifiedCount;
    } else {
      results[model].updated = ids.length;
    }
    results[model].ids = packages.map(p => p._id);
  }
  
  return results;
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const audit = args.includes('--audit');
  
  try {
    await connectDB();
    
    console.log('\n🔍 Buscando pacotes sem campo "model"...\n');
    const packages = await findPackagesWithoutModel();
    
    if (packages.length === 0) {
      console.log('✅ Nenhum pacote precisa de migração. Todos já têm o campo "model".');
      process.exit(0);
    }
    
    console.log(`📦 Encontrados ${packages.length} pacotes sem campo "model"\n`);
    
    // Categorizar
    const categories = categorizePackages(packages);
    
    console.log('📊 Distribuição inferida:\n');
    console.log(`   Liminar:     ${categories.liminar.length}`);
    console.log(`   Convênio:    ${categories.convenio.length}`);
    console.log(`   Pré-pago:    ${categories.prepaid.length}`);
    console.log(`   Por sessão:  ${categories.per_session.length}`);
    console.log(`   Incertos:    ${categories.uncertain.length}\n`);
    
    // Mostrar exemplos de cada categoria
    console.log('📝 Exemplos de inferência:\n');
    for (const [model, pkgs] of Object.entries(categories)) {
      if (pkgs.length > 0) {
        const example = pkgs[0];
        console.log(`   ${model.toUpperCase()}:`);
        console.log(`      ID: ${example._id}`);
        console.log(`      type: ${example.type}, paymentType: ${example.paymentType}`);
        console.log(`      totalValue: ${example.totalValue}, totalPaid: ${example.totalPaid}\n`);
      }
    }
    
    // Salvar audit se solicitado
    if (audit) {
      const auditFile = join(__dirname, `../tmp/migration-audit-${Date.now()}.json`);
      writeFileSync(auditFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        totalPackages: packages.length,
        categories,
        rawPackages: packages.map(p => ({
          _id: p._id.toString(),
          type: p.type,
          paymentType: p.paymentType,
          totalValue: p.totalValue,
          totalPaid: p.totalPaid,
          createdAt: p.createdAt,
          status: p.status
        }))
      }, null, 2));
      console.log(`💾 Audit salvo em: ${auditFile}\n`);
    }
    
    if (dryRun) {
      console.log('🔍 DRY-RUN: Nenhuma alteração foi feita.');
      console.log('   Execute sem --dry-run para aplicar a migração.\n');
    } else {
      console.log('⚠️  APLICANDO MIGRAÇÃO...\n');
      const results = await applyMigration(categories, false);
      
      console.log('✅ Migração concluída!\n');
      console.log('📈 Resultados:\n');
      console.log(`   Liminar:     ${results.liminar.updated} atualizados`);
      console.log(`   Convênio:    ${results.convenio.updated} atualizados`);
      console.log(`   Pré-pago:    ${results.prepaid.updated} atualizados`);
      console.log(`   Por sessao:  ${results.per_session.updated} atualizados\n`);
      
      // Verificar se sobrou algum
      const remaining = await findPackagesWithoutModel();
      if (remaining.length > 0) {
        console.log(`⚠️  Atenção: ${remaining.length} pacotes ainda sem model (casos edge)`);
      } else {
        console.log('🎉 Todos os pacotes foram migrados com sucesso!');
      }
    }
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Desconectado do MongoDB');
  }
}

main();

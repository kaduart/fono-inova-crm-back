#!/usr/bin/env node
/**
 * Setup de Ambientes - Produção e Desenvolvimento
 * 
 * Organiza os bancos:
 *   - crm_production  → Dados reais (PRODUÇÃO)
 *   - crm_development → Cópia para testes (DEV)
 * 
 * Uso:
 *   node scripts/setup-environments.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

const ENVIRONMENTS = {
  production: {
    dbName: 'crm_production',
    description: 'DADOS REAIS - PRODUÇÃO',
    color: '\x1b[31m' // Vermelho
  },
  development: {
    dbName: 'crm_development', 
    description: 'CÓPIA PARA TESTES - DEV',
    color: '\x1b[32m' // Verde
  }
};

async function setupEnvironments() {
  console.log('🎯 CONFIGURAÇÃO DE AMBIENTES\n');
  console.log('='.repeat(60));
  
  // Detecta URI atual
  const currentUri = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';
  const baseUri = currentUri.replace(/\/[^/]*$/, '');
  
  console.log('\n📊 Ambientes disponíveis:\n');
  
  for (const [key, env] of Object.entries(ENVIRONMENTS)) {
    console.log(`${env.color}${key.toUpperCase()}\x1b[0m`);
    console.log(`   Banco: ${env.dbName}`);
    console.log(`   Descrição: ${env.description}`);
    console.log(`   URI: ${baseUri}/${env.dbName}\n`);
  }
  
  console.log('='.repeat(60));
  
  // Pergunta qual ambiente configurar
  const choice = await question('\nQual ambiente deseja configurar? (production/development): ');
  
  if (!ENVIRONMENTS[choice]) {
    console.log('❌ Opção inválida. Use: production ou development');
    process.exit(1);
  }
  
  const env = ENVIRONMENTS[choice];
  const targetUri = `${baseUri}/${env.dbName}`;
  
  console.log(`\n🔧 Configurando: ${env.color}${choice.toUpperCase()}\x1b[0m`);
  console.log(`   Banco: ${env.dbName}\n`);
  
  try {
    // Testa conexão
    console.log('1️⃣ Testando conexão...');
    const conn = await mongoose.createConnection(targetUri).asPromise();
    console.log('   ✅ Conectado com sucesso\n');
    
    // Aguarda conexão estar pronta
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Lista coleções existentes
    const collections = await conn.db.listCollections().toArray();
    console.log(`2️⃣ Coleções existentes: ${collections.length}`);
    collections.forEach(c => console.log(`   📁 ${c.name}`));
    
    // Se for development e estiver vazio, oferece clonar
    if (choice === 'development' && collections.length === 0) {
      const shouldClone = await question('\nDeseja clonar dados da produção? (s/n): ');
      
      if (shouldClone.toLowerCase() === 's') {
        console.log('\n🔄 Clonando produção → desenvolvimento...\n');
        
        const prodConn = await mongoose.createConnection(`${baseUri}/crm_production`).asPromise();
        await new Promise(resolve => setTimeout(resolve, 500));
        const prodCollections = ['patients', 'doctors', 'packages', 'insuranceguides', 'users'];
        
        for (const collName of prodCollections) {
          const sourceColl = prodConn.db.collection(collName);
          const targetColl = conn.db.collection(collName);
          
          try {
            const count = await sourceColl.countDocuments();
            if (count > 0) {
              const docs = await sourceColl.find({}).limit(500).toArray();
              if (docs.length > 0) {
                await targetColl.insertMany(docs);
                console.log(`   ✅ ${collName}: ${docs.length} documentos`);
              }
            } else {
              console.log(`   ⚠️  ${collName}: vazio`);
            }
          } catch (err) {
            console.log(`   ⚠️  ${collName}: erro - ${err.message}`);
          }
        }
        
        await prodConn.close();
        console.log('\n✅ Clonagem concluída!');
      }
    }
    
    await conn.close();
    
    // Gera arquivos .env
    console.log('\n📝 Gerando arquivos de configuração...\n');
    
    const envContent = `# Ambiente: ${choice.toUpperCase()}
# ${env.description}
MONGO_URI=${targetUri}

# Feature Flags - ${choice}
FF_CREATE_V2=${choice === 'development' ? 'true' : 'false'}
FF_COMPLETE_V2=${choice === 'development' ? 'true' : 'false'}
FF_CANCEL_V2=${choice === 'development' ? 'true' : 'false'}

# Outras variáveis...
NODE_ENV=${choice === 'production' ? 'production' : 'development'}
`;
    
    const fs = await import('fs');
    const envFile = `.env.${choice}`;
    fs.writeFileSync(envFile, envContent);
    console.log(`   ✅ Arquivo criado: ${envFile}`);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ CONFIGURAÇÃO CONCLUÍDA!');
    console.log('='.repeat(60));
    console.log(`\nPara usar este ambiente:`);
    console.log(`   cp ${envFile} .env`);
    console.log(`   npm run dev`);
    console.log(`\nOu diretamente:`);
    console.log(`   MONGO_URI=${targetUri} npm run dev`);
    
  } catch (error) {
    console.error('\n❌ ERRO:', error.message);
  } finally {
    rl.close();
  }
}

setupEnvironments();

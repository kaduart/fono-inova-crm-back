#!/usr/bin/env node
/**
 * 🔄 Script de Réplica de Dados para Development
 * 
 * Requisitos:
 * - Node.js
 * - MongoDB Database Tools (mongodump, mongorestore)
 * 
 * Uso:
 *   node scripts/replicar_dados_producao.js
 * 
 * Atenção: Isso vai APAGAR o banco crm_development e recriar com os dados de produção
 */

import { execSync } from 'child_process';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Configurações
const MONGO_CLUSTER = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net';
const DB_ORIGEM = 'test';  // 🎯 BD de PRODUÇÃO
const DB_DESTINO = 'crm_development';

console.log(`
╔══════════════════════════════════════════════════════════╗
║  🔄 RÉPLICA DE DADOS MONGODB                             ║
╠══════════════════════════════════════════════════════════╣
║  Origem:  ${DB_ORIGEM.padEnd(46)} ║
║  Destino: ${DB_DESTINO.padEnd(46)} ║
╚══════════════════════════════════════════════════════════╝

⚠️  ATENÇÃO: Isso vai APAGAR todo o banco ${DB_DESTINO}!
`);

rl.question('Tem certeza que deseja continuar? (digite SIM para confirmar): ', (resposta) => {
    if (resposta.trim() !== 'SIM') {
        console.log('❌ Operação cancelada.');
        rl.close();
        process.exit(0);
    }

    console.log('\n🚀 Iniciando réplica...\n');

    try {
        // Step 1: Backup do banco de destino (safety)
        console.log('💾 Criando backup de segurança do destino...');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = `/tmp/mongodb_backup_${DB_DESTINO}_${timestamp}`;
        
        try {
            execSync(`mongodump --uri "${MONGO_CLUSTER}/${DB_DESTINO}" --out ${backupDir}`, {
                stdio: 'inherit'
            });
            console.log(`✅ Backup salvo em: ${backupDir}\n`);
        } catch (e) {
            console.log('⚠️  Não foi possível fazer backup (pode ser que o banco esteja vazio)');
        }

        // Step 2: Dump do banco de origem
        console.log('📥 Exportando dados de origem...');
        const dumpDir = `/tmp/mongodb_dump_${DB_ORIGEM}_${timestamp}`;
        
        execSync(`mongodump --uri "${MONGO_CLUSTER}/${DB_ORIGEM}" --out ${dumpDir}`, {
            stdio: 'inherit'
        });
        console.log('✅ Dump completo\n');

        // Step 3: Dropar banco de destino
        console.log('🗑️  Limpando banco de destino...');
        execSync(`mongosh "${MONGO_CLUSTER}/${DB_DESTINO}" --eval "db.dropDatabase()"`, {
            stdio: 'inherit'
        });
        console.log('✅ Banco de destino limpo\n');

        // Step 4: Restore para o destino
        console.log('📤 Importando dados para destino...');
        execSync(`mongorestore --uri "${MONGO_CLUSTER}/${DB_DESTINO}" --nsFrom "${DB_ORIGEM}.*" --nsTo "${DB_DESTINO}.*" ${dumpDir}/${DB_ORIGEM}`, {
            stdio: 'inherit'
        });
        console.log('✅ Importação completa\n');

        // Step 5: Limpar temporários
        console.log('🧹 Limpando arquivos temporários...');
        execSync(`rm -rf ${dumpDir}`);
        
        console.log(`
╔══════════════════════════════════════════════════════════╗
║  ✅ RÉPLICA CONCLUÍDA COM SUCESSO!                       ║
╠══════════════════════════════════════════════════════════╣
║  Banco: ${DB_DESTINO.padEnd(50)} ║
║  Origem: ${DB_ORIGEM.padEnd(49)} ║
╚══════════════════════════════════════════════════════════╝

🚀 Agora você pode reiniciar o backend e testar com dados reais!
        `);

    } catch (error) {
        console.error('\n❌ ERRO:', error.message);
        console.log('\n⚠️  Possíveis causas:');
        console.log('   1. MongoDB Database Tools não instalado');
        console.log('      → sudo apt-get install mongodb-database-tools');
        console.log('   2. Sem conexão com o cluster');
        console.log('   3. Permissões insuficientes');
        process.exit(1);
    }

    rl.close();
});

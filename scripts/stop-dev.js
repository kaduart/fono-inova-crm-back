#!/usr/bin/env node
/**
 * 🛑 Script de Encerramento para Desenvolvimento
 * 
 * Encerra o servidor Node.js e opcionalmente o Redis
 * Uso: npm stop
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🛑 Encerrando ambiente de desenvolvimento...\n');

async function stopServer() {
    try {
        // Procura processos Node.js rodando o server.js
        const { stdout } = await execAsync("ps aux | grep 'node.*server.js' | grep -v grep");
        
        if (stdout) {
            console.log('📝 Processos encontrados:');
            console.log(stdout);
            
            // Extrai PIDs e mata os processos
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const pid = line.trim().split(/\s+/)[1];
                if (pid) {
                    try {
                        process.kill(parseInt(pid), 'SIGTERM');
                        console.log(`✅ Processo ${pid} encerrado`);
                    } catch (e) {
                        console.log(`⚠️  Não foi possível encerrar processo ${pid}`);
                    }
                }
            }
        } else {
            console.log('ℹ️  Nenhum processo do servidor encontrado');
        }
    } catch (error) {
        console.log('ℹ️  Nenhum processo do servidor encontrado');
    }
}

async function stopRedis() {
    try {
        await execAsync('redis-cli shutdown');
        console.log('✅ Redis encerrado');
    } catch (error) {
        console.log('ℹ️  Redis não estava rodando ou não pôde ser encerrado');
    }
}

async function main() {
    await stopServer();
    await stopRedis();
    console.log('\n👋 Ambiente de desenvolvimento encerrado!');
}

main().catch(console.error);

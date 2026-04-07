#!/usr/bin/env node
/**
 * 🚀 Script de Inicialização para Desenvolvimento
 * 
 * Inicia o Redis (se não estiver rodando), o servidor Node.js e os workers
 * Uso: npm run dev
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';

// Workers a serem iniciados
const WORKERS = [
    { name: '👨‍⚕️ Doctor Worker', file: './workers/doctor.worker.js' },
    { name: '📋 Followup Worker', file: './workers/followup.worker.js' },
];

console.log('🔧 Iniciando ambiente de desenvolvimento...\n');

// Guarda referências dos processos filhos
const childProcesses = [];

// Função para verificar se o Redis está rodando
async function isRedisRunning() {
    try {
        await execAsync(`redis-cli -h ${REDIS_HOST} -p ${REDIS_PORT} ping`);
        return true;
    } catch {
        return false;
    }
}

// Função para iniciar o Redis
async function startRedis() {
    console.log('🔄 Redis não está rodando. Iniciando...');
    
    try {
        // Tenta iniciar o Redis em background
        await execAsync('redis-server --daemonize yes');
        
        // Aguarda o Redis ficar pronto
        let retries = 10;
        while (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const isRunning = await isRedisRunning();
            if (isRunning) {
                console.log('✅ Redis iniciado com sucesso!\n');
                return true;
            }
            retries--;
        }
        
        throw new Error('Timeout ao aguardar Redis iniciar');
    } catch (error) {
        console.error('❌ Erro ao iniciar Redis:', error.message);
        console.log('💡 Verifique se o Redis está instalado:');
        console.log('   sudo apt-get install redis-server  (Ubuntu/Debian)');
        console.log('   sudo systemctl start redis         (se estiver usando systemd)\n');
        return false;
    }
}

// Função para iniciar um worker
function startWorker(worker) {
    console.log(`🔄 Iniciando ${worker.name}...`);
    
    const proc = spawn('node', ['-r', 'dotenv/config', worker.file], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' }
    });
    
    proc.on('close', (code) => {
        console.log(`⚠️  ${worker.name} encerrou com código ${code}`);
    });
    
    childProcesses.push(proc);
    console.log(`✅ ${worker.name} iniciado!\n`);
    return proc;
}

// Função principal
async function main() {
    // Verifica se Redis está rodando
    const redisRunning = await isRedisRunning();
    
    if (!redisRunning) {
        const started = await startRedis();
        if (!started) {
            console.warn('⚠️  Continuando sem Redis... Algumas funcionalidades podem não funcionar.\n');
        }
    } else {
        console.log('✅ Redis já está rodando!\n');
    }
    
    // Inicia os workers
    console.log('🚀 Iniciando workers...\n');
    WORKERS.forEach(worker => startWorker(worker));
    
    // Inicia o servidor Node.js
    console.log('🚀 Iniciando servidor Node.js...\n');
    
    const server = spawn('node', ['-r', 'dotenv/config', 'server.js'], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' }
    });
    
    childProcesses.push(server);
    
    server.on('close', (code) => {
        console.log(`\n👋 Servidor encerrou com código ${code}`);
        // Encerra todos os workers
        childProcesses.forEach(proc => {
            if (proc !== server && !proc.killed) {
                proc.kill('SIGTERM');
            }
        });
        process.exit(code);
    });
    
    // Encerra todos os processos quando o servidor for encerrado
    process.on('SIGINT', () => {
        console.log('\n\n👋 Encerrando ambiente de desenvolvimento...');
        childProcesses.forEach(proc => {
            if (!proc.killed) {
                proc.kill('SIGINT');
            }
        });
    });
    
    process.on('SIGTERM', () => {
        childProcesses.forEach(proc => {
            if (!proc.killed) {
                proc.kill('SIGTERM');
            }
        });
    });
}

main().catch(console.error);

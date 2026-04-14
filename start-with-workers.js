#!/usr/bin/env node
/**
 * 🚀 Inicia servidor + workers localmente
 * Uso: npm run dev:check
 */
import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

console.log('🚀 Iniciando servidor + workers localmente...\n');

// 1. Inicia o servidor (ENABLE_WORKERS=false para não duplicar)
const server = spawn('node', ['server.js'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ENABLE_WORKERS: 'false' }
});

// 2. Inicia os workers em processo separado
const workers = spawn('node', ['workers/startWorkers.js'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ENABLE_WORKERS: 'true', WORKER_GROUP: 'all' }
});

function killAll(code = 0) {
    server.kill();
    workers.kill();
    process.exit(code);
}

server.on('close', (code) => {
    console.log('\n🛑 Servidor encerrou. Parando workers...');
    killAll(code);
});

workers.on('close', (code) => {
    console.log('\n🛑 Workers encerraram. Parando servidor...');
    killAll(code);
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT recebido. Encerrando tudo...');
    killAll(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM recebido. Encerrando tudo...');
    killAll(0);
});

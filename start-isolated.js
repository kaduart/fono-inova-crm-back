#!/usr/bin/env node
/**
 * 🚀 Inicia API + 1 grupo de worker isolado
 * Uso: npm run dev:isolated:billing
 */
import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const group = process.argv[2] || process.env.WORKER_GROUP;

if (!group) {
  console.error('❌ Especifique o grupo de worker:');
  console.error('   npm run dev:isolated:billing');
  console.error('   Grupos válidos: scheduling, billing, clinical, whatsapp, reconciliation');
  process.exit(1);
}

console.log(`🚀 Iniciando API + worker group: ${group}\n`);

// 1. API com projections ligadas
const server = spawn('node', ['server.js'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ENABLE_WORKERS: 'false',
    ENABLE_PROJECTIONS: 'true'
  }
});

// 2. Worker isolado
const worker = spawn('node', ['workers/startWorkers.js'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ENABLE_WORKERS: 'true',
    WORKER_GROUP: group
  }
});

function killAll(code = 0) {
  server.kill();
  worker.kill();
  process.exit(code);
}

server.on('close', (code) => {
  console.log(`\n🛑 Servidor encerrou. Parando worker ${group}...`);
  killAll(code);
});

worker.on('close', (code) => {
  console.log(`\n🛑 Worker ${group} encerrou. Parando servidor...`);
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

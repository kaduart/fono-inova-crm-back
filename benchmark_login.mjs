#!/usr/bin/env node
/**
 * Benchmark de Login - Coleta tempos reais de cada etapa
 * Usage: node benchmark_login.mjs
 */

const BASE_URL = 'http://localhost:5000';

// Credenciais REAIS do banco
const TEST_ACCOUNTS = [
  { email: 'clinicafonoinova@gmail.com', password: 'wrongpass', role: 'admin' },
  { email: 'clinicafonoinova@gmail.com', password: 'wrongpass', role: 'doctor' },
  { email: 'barbaramr22@outlook.com', password: 'wrongpass', role: 'patient' },
];

async function login(email, password, role) {
  const start = Date.now();
  const response = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  });
  const total = Date.now() - start;
  
  return {
    status: response.status,
    total,
    ok: response.ok,
  };
}

async function benchmark() {
  console.log('🔥 LOGIN BENCHMARK - 10 rodadas');
  console.log('='.repeat(60));
  
  const results = [];
  
  for (let i = 1; i <= 10; i++) {
    const account = TEST_ACCOUNTS[i % TEST_ACCOUNTS.length];
    
    process.stdout.write(`  Rodada ${i.toString().padStart(2)}/10... `);
    
    try {
      const result = await login(account.email, account.password, account.role);
      results.push({ ...result, role: account.role });
      process.stdout.write(`${result.total}ms (${result.status})\n`);
    } catch (err) {
      process.stdout.write(`ERRO: ${err.message}\n`);
    }
    
    // Pequeno delay entre requests
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Estatísticas
  console.log('\n📊 RESULTADOS:');
  console.log('-'.repeat(60));
  
  const successTimes = results.filter(r => r.ok).map(r => r.total);
  const failTimes = results.filter(r => !r.ok).map(r => r.total);
  
  if (successTimes.length > 0) {
    const avg = successTimes.reduce((a, b) => a + b, 0) / successTimes.length;
    const min = Math.min(...successTimes);
    const max = Math.max(...successTimes);
    
    console.log(`  Sucessos: ${successTimes.length}/${results.length}`);
    console.log(`  Média:    ${avg.toFixed(1)}ms`);
    console.log(`  Min:      ${min}ms`);
    console.log(`  Max:      ${max}ms`);
  }
  
  if (failTimes.length > 0) {
    console.log(`  Falhas:   ${failTimes.length}`);
  }
  
  console.log('\n📋 CHECK SERVER LOGS para breakdown:');
  console.log('  grep "LOGIN_TIMING" server.log');
}

benchmark().catch(console.error);

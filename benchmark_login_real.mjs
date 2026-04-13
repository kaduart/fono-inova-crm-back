#!/usr/bin/env node
/**
 * Benchmark de Login com credencial REAL
 */

const BASE_URL = 'http://localhost:5000';

// Credencial real
const REAL_ACCOUNT = {
  email: 'clinicafonoinova@gmail.com',
  password: 'admin1234',
  role: 'admin'
};

async function login(email, password, role) {
  const start = performance.now();
  const response = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  });
  const total = performance.now() - start;
  
  const data = await response.json().catch(() => ({}));
  
  return {
    status: response.status,
    total: Math.round(total),
    ok: response.ok,
    hasToken: !!data.token,
  };
}

async function benchmark() {
  console.log('🔥 LOGIN BENCHMARK - Credencial REAL (admin)');
  console.log('='.repeat(60));
  
  const results = [];
  
  for (let i = 1; i <= 10; i++) {
    process.stdout.write(`  Rodada ${i.toString().padStart(2)}/10... `);
    
    try {
      const result = await login(REAL_ACCOUNT.email, REAL_ACCOUNT.password, REAL_ACCOUNT.role);
      results.push(result);
      process.stdout.write(`${result.total}ms (${result.status}) ${result.hasToken ? '✅ TOKEN' : '❌ NO TOKEN'}\n`);
    } catch (err) {
      process.stdout.write(`ERRO: ${err.message}\n`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log('\n📊 ESTATÍSTICAS:');
  console.log('-'.repeat(60));
  
  const success = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  
  if (success.length > 0) {
    const times = success.map(r => r.total);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    
    console.log(`  Sucessos: ${success.length}/10`);
    console.log(`  Média:    ${avg.toFixed(1)}ms`);
    console.log(`  Min:      ${min}ms`);
    console.log(`  Max:      ${max}ms`);
    
    if (max > 500) {
      console.log(`  ⚠️  ALERTA: Login muito lento (>500ms)`);
    } else if (avg > 200) {
      console.log(`  ⚠️  ATENÇÃO: Login lento (>200ms média)`);
    } else {
      console.log(`  ✅ Login rápido`);
    }
  }
  
  if (fail.length > 0) {
    console.log(`\n  ❌ Falhas: ${fail.length}`);
    fail.forEach((f, i) => console.log(`     ${i+1}. ${f.total}ms (status ${f.status})`));
  }
}

benchmark().catch(console.error);

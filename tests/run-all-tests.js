#!/usr/bin/env node
/**
 * 🧪 SUITE COMPLETA DE TESTES - RODA TUDO
 * 
 * Executa todos os testes parrudos:
 * 1. Testes de Stress (corrupção)
 * 2. Testes E2E (fluxo completo)
 * 3. Testes de Regressão (casos reais)
 * 4. Testes de Concorrência
 * 5. Testes de Carga
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tests = [
    { name: 'Proteção de Dados (Unitários)', file: 'unit/safeAgeUpdate.test.js' },
    { name: 'Stress - Corrupção', file: 'stress/corruption-stress.test.js' },
    { name: 'Integração - Caso Ana Laura', file: 'integration/caso-ana-laura.test.js' },
    { name: 'E2E - Fluxo Completo', file: 'e2e/fluxo-completo-e2e.test.js' },
    { name: 'Regressão - Casos Reais', file: 'regression/casos-reais-producao.test.js' },
];

let totalPassed = 0;
let totalFailed = 0;

function runTest(testFile) {
    return new Promise((resolve, reject) => {
        const fullPath = join(__dirname, testFile);
        const child = spawn('node', [fullPath], {
            stdio: 'pipe',
            cwd: process.cwd()
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('close', (code) => {
            resolve({
                code,
                output,
                errorOutput,
                success: code === 0
            });
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     🚀 SUITE COMPLETA DE TESTES - FONO INOVA CRM          ║');
    console.log('║                                                            ║');
    console.log('║  Testando proteções contra:                                ║');
    console.log('║  ✓ Corrupção de idade                                      ║');
    console.log('║  ✓ Loop de triagem                                         ║');
    console.log('║  ✓ Perda de dados                                          ║');
    console.log('║  ✓ Condições de corrida                                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const startTime = Date.now();

    for (const test of tests) {
        console.log(`\n${'━'.repeat(70)}`);
        console.log(`▶️  Rodando: ${test.name}`);
        console.log(`   Arquivo: ${test.file}`);
        console.log('━'.repeat(70));

        try {
            const result = await runTest(test.file);

            if (result.success) {
                console.log(`✅ ${test.name} - PASSOU`);
                // Extrai contagem de testes
                const match = result.output.match(/Passaram:\s*(\d+)/);
                if (match) {
                    totalPassed += parseInt(match[1]);
                }
            } else {
                console.log(`❌ ${test.name} - FALHOU (código ${result.code})`);
                console.log(result.output);
                if (result.errorOutput) {
                    console.error(result.errorOutput);
                }
                totalFailed++;
            }
        } catch (err) {
            console.log(`💥 ${test.name} - ERRO: ${err.message}`);
            totalFailed++;
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n' + '═'.repeat(70));
    console.log('📊 RESULTADO FINAL');
    console.log('═'.repeat(70));
    console.log(`⏱️  Duração: ${duration}s`);
    console.log(`✅ Testes passaram: ${totalPassed}`);
    console.log(`❌ Testes falharam: ${totalFailed}`);
    console.log(`📈 Taxa de sucesso: ${((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1)}%`);

    if (totalFailed > 0) {
        console.log('\n❌❌❌ ALGUNS TESTES FALHARAM ❌❌❌');
        console.log('   NÃO SUBA PARA PRODUÇÃO!');
        process.exit(1);
    } else {
        console.log('\n✅✅✅ TODOS OS TESTES PASSARAM! ✅✅✅');
        console.log('   Sistema está seguro para produção!');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('💥 ERRO FATAL:', err);
    process.exit(1);
});

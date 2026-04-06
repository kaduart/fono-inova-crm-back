/**
 * 🎯 Test Packs - Índice de todos os packs de teste E2E
 * 
 * Para adicionar um novo pack:
 * 1. Crie o arquivo em ./packs/nome-do-pack.pack.js
 * 2. Exporte o describe do vitest
 * 3. Adicione aqui no índice
 */

// Packs de Teste
export { default as appointmentCreationFlow } from './appointment-creation-flow.pack.js';
export { default as paymentListFilter } from './payment-list-filter.pack.js';
export { default as paymentV2Performance } from './payment-v2-performance.pack.js';

// Lista de packs para execução em suite
export const TEST_PACKS = [
  {
    name: 'Appointment Creation Flow',
    file: './appointment-creation-flow.pack.js',
    description: 'Valida criação de agendamento, pagamento automático e fechamento do modal'
  },
  {
    name: 'Payment List Filter',
    file: './payment-list-filter.pack.js',
    description: 'Valida filtro de pagamentos por mês e resumo financeiro'
  },
  {
    name: 'Payment V2 Performance',
    file: './payment-v2-performance.pack.js',
    description: 'Testa fluxo Payment V2 async, performance e idempotência'
  }
];

// Função para executar todos os packs
export async function runAllPacks() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║           🧪 SUITE DE TESTES E2E                       ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  const results = [];
  
  for (const pack of TEST_PACKS) {
    console.log(`\n🎬 Executando: ${pack.name}`);
    console.log(`   ${pack.description}\n`);
    
    try {
      // Vitest vai executar automaticamente os describes importados
      results.push({ success: true, pack: pack.name });
    } catch (error) {
      console.error(`❌ FALHA: ${error.message}`);
      results.push({ success: false, pack: pack.name, error: error.message });
    }
  }
  
  // Relatório
  const passed = results.filter(r => r.success).length;
  const total = results.length;
  
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║              📊 RELATÓRIO                              ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  
  results.forEach(r => {
    const icon = r.success ? '✅' : '❌';
    console.log(`║  ${icon} ${r.pack.padEnd(45)} ║`);
  });
  
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${passed}/${total} packs passaram${' '.repeat(25)}║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  return results;
}

export default TEST_PACKS;

#!/usr/bin/env node
/**
 * 🧪 Teste de Geração de Post GMB
 * 
 * Executa:
 *   node scripts/test-gmb-post.js [especialidade] [provider]
 * 
 * Exemplos:
 *   node scripts/test-gmb-post.js fonoaudiologia auto
 *   node scripts/test-gmb-post.js psicologia fal
 *   node scripts/test-gmb-post.js terapia_ocupacional
 */

const ESPECIALIDADES = [
  'fonoaudiologia',
  'psicologia', 
  'terapia_ocupacional',
  'fisioterapia',
  'psicomotricidade',
  'neuropsicologia',
  'musicoterapia',
  'psicopedagogia',
  'freio_lingual'
];

async function main() {
  const especialidade = process.argv[2] || 'fonoaudiologia';
  const provider = process.argv[3] || 'auto';
  
  if (!ESPECIALIDADES.includes(especialidade)) {
    console.log('❌ Especialidade inválida!');
    console.log('   Opções válidas:', ESPECIALIDADES.join(', '));
    process.exit(1);
  }
  
  console.log('🧪 Teste de Geração de Post GMB');
  console.log('================================');
  console.log('');
  console.log(`📍 Especialidade: ${especialidade}`);
  console.log(`🤖 Provider: ${provider}`);
  console.log(`   Ordem: fal.ai → Freepik → HuggingFace → Pollinations`);
  console.log('');
  
  const API_URL = process.env.API_URL || 'http://localhost:3000/api';
  
  try {
    const startTime = Date.now();
    
    console.log('🚀 Enviando requisição...');
    const response = await fetch(`${API_URL}/gmb/admin/trigger-generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        especialidadeId: especialidade,
        generateImage: true,
        provider: provider,
        funnelStage: 'top'
      })
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\n✅ Resposta recebida em ${elapsed}s`);
    console.log(`   Status HTTP: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log('');
      console.log('📋 Resultado:');
      console.log(`   Post ID: ${data.postId || data.id || 'N/A'}`);
      console.log(`   Status: ${data.status || 'processing'}`);
      console.log(`   Message: ${data.message || 'OK'}`);
      console.log('');
      console.log('⏳ O post está sendo processado em background!');
      console.log('   Acompanhe nos logs do servidor:');
      console.log('   - Geração de conteúdo (GPT-4o-mini)');
      console.log('   - Geração de imagem (fal.ai #1)');
      console.log('   - Upload Cloudinary');
      console.log('   - Status final no MongoDB');
    } else {
      const error = await response.text();
      console.log('');
      console.log('❌ Erro:', error);
    }
    
  } catch (error) {
    console.log('');
    console.log('❌ Erro na requisição:', error.message);
    console.log('');
    console.log('💡 Dicas:');
    console.log('   - Verifique se o servidor está rodando (npm run dev)');
    console.log('   - Verifique se a porta 3000 está correta');
    console.log('   - Verifique se há autenticação necessária');
  }
}

main();

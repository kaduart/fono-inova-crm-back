import * as gmbService from './services/gmbService.js';

async function test() {
  try {
    const result = await gmbService.publishToGMB({
      title: 'Teste',
      content: 'Teste de publicação GMB',
      ctaUrl: 'https://www.clinicafonoinova.com.br'
    });
    console.log('✅ SUCESSO:', result);
  } catch (error) {
    console.error('❌ ERRO:', error.message);
  }
  process.exit();
}

test();
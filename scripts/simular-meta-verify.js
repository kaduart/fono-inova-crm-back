/**
 * Simula EXATAMENTE a requisição que o Meta faz
 */

const TESTS = [
  {
    name: "Meta Verify (exato)",
    url: "https://fono-inova-crm-back.onrender.com/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=fono-inova-verify-2025&hub.challenge=123456789"
  },
  {
    name: "Sem hub.mode",
    url: "https://fono-inova-crm-back.onrender.com/api/whatsapp/webhook?hub.verify_token=fono-inova-verify-2025&hub.challenge=123"
  },
  {
    name: "Token errado",
    url: "https://fono-inova-crm-back.onrender.com/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=token-errado&hub.challenge=123"
  }
];

async function testar() {
  for (const test of TESTS) {
    console.log(`\n🧪 ${test.name}`);
    console.log(`URL: ${test.url}`);
    
    try {
      const res = await fetch(test.url);
      const text = await res.text();
      
      console.log(`Status: ${res.status}`);
      console.log(`Resposta: "${text}"`);
      
      if (res.status === 200 && text === '123456789') {
        console.log('✅ PASSOU!');
      } else if (res.status === 200 && text === '123') {
        console.log('✅ PASSOU!');
      } else {
        console.log('❌ FALHOU!');
      }
    } catch (err) {
      console.log(`❌ ERRO: ${err.message}`);
    }
  }
}

testar();

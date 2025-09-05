// scripts/testSicoobAuth.js
import getSicoobAccessToken from '../services/sicoobAuth.js';

(async () => {
  try {
    const token = await getSicoobAccessToken();
    console.log('✅ Token Sicoob obtido com sucesso:', token);
  } catch (err) {
    console.error('❌ Erro ao obter token Sicoob:', err.message);
  }
})();

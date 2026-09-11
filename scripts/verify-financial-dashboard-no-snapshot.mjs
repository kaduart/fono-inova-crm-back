/**
 * Somente leitura. Verificação pontual pós-fix: invoca diretamente o handler
 * de GET /v2/financial/dashboard (pulando o middleware `auth`) pra julho/2026,
 * confirmando que a remoção do atalho de FinancialDailySnapshot em
 * financialDashboard.v2.js não quebrou a rota e que os números batem com
 * calculateMetaRealizada (fonte oficial). Nenhuma escrita é feita.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado');
  process.exit(1);
}

await mongoose.connect(mongoUri);
await import('../models/index.js');

const router = (await import('../routes/financialDashboard.v2.js')).default;

const layer = router.stack.find(l => l.route?.path === '/' && l.route?.methods?.get);
if (!layer) {
  console.error('Não achou a rota GET / no router');
  process.exit(1);
}
// pula o middleware `auth` (stack[0]) e chama direto o handler (stack[1])
const handler = layer.route.stack[1].handle;

const req = { query: { month: '7', year: '2026' }, user: { id: 'diagnostic-script', name: 'diagnostic-script' } };
const res = {
  _status: 200,
  status(code) { this._status = code; return this; },
  setHeader() {},
  json(body) {
    console.log('HTTP status:', this._status);
    console.log('success:', body.success);
    console.log('source (esperado sempre real-time agora):', body.source);
    console.log('resumo.caixa:', body.resumo?.caixa);
    console.log('resumo.producao:', body.resumo?.producao);
    console.log('resumo.producaoDetalhe:', JSON.stringify(body.resumo?.producaoDetalhe));
    console.log('resumo.particularPendente:', body.resumo?.particularPendente);
    console.log('resumo.pacotePendente:', body.resumo?.pacotePendente);
    console.log('resumo.metas.ritmo.percentualRealizado:', body.resumo?.metas?.ritmo?.percentualRealizado);
    console.log('resumo.metas.realizado.mes (deve ser 34260):', body.resumo?.metas?.realizado?.mes);
    console.log('resumo.comparativos:', JSON.stringify(body.resumo?.comparativos ?? body.data?.comparativos));
    process.exit(body.success ? 0 : 1);
  }
};

try {
  await handler(req, res);
} catch (err) {
  console.error('ERRO ao chamar o handler:', err);
  process.exit(1);
}

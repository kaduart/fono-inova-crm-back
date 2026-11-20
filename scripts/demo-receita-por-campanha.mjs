// scripts/demo-receita-por-campanha.mjs
// Demonstração LOCAL da receita recebida por campanha com a amostra FICTÍCIA.
// Não conecta em banco, não lê .env, não envia nada: só roda o núcleo puro e imprime a tabela.
// Uso:  node scripts/demo-receita-por-campanha.mjs [--json]
import { attributeReceivedRevenue } from '../services/attribution/revenueAttribution.js';
import { amostra, ESPERADO } from '../services/attribution/fixtures/receitaFicticia.js';

const r = attributeReceivedRevenue(amostra);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.invariante.fecha ? 0 : 1);
}

const brl = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;
const pad = (s, n) => String(s).padEnd(n);
const painelAntigo = amostra.adConversions.reduce((s, c) => s + (c.value || 0), 0);

console.log('\nReceita RECEBIDA por campanha — amostra fictícia (sem banco)\n');
console.log(pad('nível', 12), pad('origem', 12), pad('campanha/anúncio', 20), pad('recebido', 12), pad('estornos', 12), 'líquido');
for (const l of r.linhas) {
  console.log(pad(l.nivel, 12), pad(l.origem, 12), pad(l.campanha || l.adId || '-', 20), pad(brl(l.recebido), 12), pad(brl(l.estornos), 12), brl(l.liquido));
}
console.log(pad('sem_vinculo', 12), pad('-', 12), pad('-', 20), pad(brl(r.semVinculo.recebido), 12), pad(brl(r.semVinculo.estornos), 12), brl(r.semVinculo.liquido),
  ' motivos:', JSON.stringify(r.semVinculo.motivos));
console.log('\nPor nível:', Object.entries(r.porNivel).map(([k, v]) => `${k} ${brl(v)}`).join(' + '));
console.log('Total líquido do ledger:', brl(r.totalLiquidoLedger), '| invariante fecha:', r.invariante.fecha ? 'SIM' : 'NÃO');
console.log('Fora da soma (não é caixa):', JSON.stringify(r.excluidos));
console.log('Painel antigo (soma de AdConversion.value):', brl(painelAntigo));
const ok = r.invariante.fecha && r.totalLiquidoLedger === ESPERADO.total
  && ['comprovada', 'provavel', 'sem_vinculo'].every((n) => r.porNivel[n] === ESPERADO[n]);
const conta = `${ESPERADO.total} = ${ESPERADO.comprovada} + ${ESPERADO.provavel} + ${ESPERADO.sem_vinculo}`;
console.log(ok ? `\nOK: bate com a amostra (${conta}).\n` : `\nDIVERGÊNCIA com a amostra (${conta}).\n`);
process.exit(ok ? 0 : 1);

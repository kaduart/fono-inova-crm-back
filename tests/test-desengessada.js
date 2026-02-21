/**
 * 🧪 TESTE DA VERSÃO DESENGESSADA
 * Valida: escape hatch, scoring fuzzy, whitelist dinâmica
 */

import { extractEntities } from './services/intelligence/EntityExtractor.js';
import { mergeContext, DEFAULT_CONTEXT } from '../services/intelligence/ContextManager.js';
import { isWhitelisted, addToWhitelist, reloadWhitelist, getWhitelistStats } from '../services/intelligence/WhitelistManager.js';
import { getValidationStats, calculateNameConfidence, checkExplicitName } from '../services/intelligence/EntityValidator.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`${GREEN}✓${RESET} ${msg}`); pass++; }
  else { console.log(`${RED}✗${RESET} ${msg}`); fail++; }
}

function section(title) {
  console.log(`\n${YELLOW}═══════════════════════════════════════════════════${RESET}`);
  console.log(`${YELLOW}${title}${RESET}`);
  console.log(`${YELLOW}═══════════════════════════════════════════════════${RESET}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('🛡️ TESTE 1: Escape Hatch - "meu nome é"');
// ═══════════════════════════════════════════════════════════════════════════

let explicit = checkExplicitName('meu nome é Pedro');
assert(explicit?.name === 'Pedro', 'Detecta "meu nome é Pedro"');

explicit = checkExplicitName('me chamo Ana Clara');
assert(explicit?.name === 'Ana Clara', 'Detecta "me chamo Ana Clara"');

explicit = checkExplicitName('sou o João Miguel');
assert(explicit?.name === 'João Miguel', 'Detecta "sou o João Miguel"');

// Caso crítico: idade na mesma frase mas nome explícito
let ctx = { ...DEFAULT_CONTEXT };
let extracted = extractEntities('meu nome é Pedro e meu filho tem 3 anos', ctx);
ctx = mergeContext(ctx, extracted);
assert(ctx.patientName === 'Pedro', '🎯 Escape hatch funciona mesmo com idade na frase!');
assert(ctx.age === 3, 'Idade 3 também extraída');

// ═══════════════════════════════════════════════════════════════════════════
section('🧮 TESTE 2: Scoring Fuzzy');
// ═══════════════════════════════════════════════════════════════════════════

// Nome claro deve ter score alto
let score = calculateNameConfidence('Ana Clara', {});
assert(score >= 70, `"Ana Clara" tem score alto (${score})`);

// Idade deve ter score baixo
score = calculateNameConfidence('2 anos', {});
assert(score < 60, `"2 anos" tem score baixo (${score})`);

// Whitelist aumenta score
reloadWhitelist(true);
score = calculateNameConfidence('Ana', {});
assert(score === 100, `"Ana" na whitelist = score 100`);

// ═══════════════════════════════════════════════════════════════════════════
section('📋 TESTE 3: Whitelist Dinâmica');
// ═══════════════════════════════════════════════════════════════════════════

// Verifica nomes da whitelist
assert(isWhitelisted('Ana'), 'Ana está na whitelist');
assert(isWhitelisted('Anoar'), 'Anoar está na whitelist');
assert(isWhitelisted('Décio'), 'Décio está na whitelist');

// Adiciona novo nome em runtime
addToWhitelist('NovoNomeRaro', { persist: false });
assert(isWhitelisted('NovoNomeRaro'), 'Novo nome adicionado em runtime');

console.log('\n📊 Stats da whitelist:', getWhitelistStats());

// ═══════════════════════════════════════════════════════════════════════════
section('🔄 TESTE 4: Fluxo Completo com Escape Hatch');
// ═══════════════════════════════════════════════════════════════════════════

ctx = { ...DEFAULT_CONTEXT };
const fluxo = [
  { msg: 'Oi quero agendar', check: (c) => !c.patientName },
  { msg: 'para fonoaudiologia', check: (c) => c.therapy === 'fonoaudiologia' },
  { msg: 'meu nome é Maria Eduarda', check: (c) => c.patientName === 'Maria Eduarda' },
  { msg: 'ela tem 5 anos', check: (c) => c.age === 5 && c.patientName === 'Maria Eduarda' },
];

for (const { msg, check } of fluxo) {
  extracted = extractEntities(msg, ctx);
  ctx = mergeContext(ctx, extracted);
  const result = check(ctx);
  assert(result, `"${msg.substring(0, 30)}..."`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('🎯 TESTE 5: Proteção mantida contra "2 anos"');
// ═══════════════════════════════════════════════════════════════════════════

ctx = { ...DEFAULT_CONTEXT };
extracted = extractEntities('Ana Clara', ctx);
ctx = mergeContext(ctx, extracted);
assert(ctx.patientName === 'Ana Clara', 'Nome inicial: Ana Clara');

extracted = extractEntities('2 anos', ctx);
ctx = mergeContext(ctx, extracted);
assert(ctx.patientName === 'Ana Clara' && ctx.age === 2, '🛡️ "2 anos" não sobrescreveu "Ana Clara"!');

// ═══════════════════════════════════════════════════════════════════════════
section('📊 ESTATÍSTICAS FINAIS');
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n📈 Stats do validador:', getValidationStats());

console.log(`\n${GREEN}Total: ${pass + fail}${RESET}`);
console.log(`${GREEN}Passaram: ${pass}${RESET}`);
console.log(`${fail > 0 ? RED : GREEN}Falharam: ${fail}${RESET}`);

const pct = ((pass / (pass + fail)) * 100).toFixed(1);
console.log(`\nTaxa: ${pct}%`);

if (fail === 0) {
  console.log(`\n${GREEN}✅ Sistema desengessado e pronto!${RESET}`);
} else {
  console.log(`\n${RED}⚠️  ${fail} falha(s)${RESET}`);
}

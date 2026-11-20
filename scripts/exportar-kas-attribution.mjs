// scripts/exportar-kas-attribution.mjs
// Gera os 4 CSVs do KAS Attribution (customers, contacts, receipts, refunds) a partir dos MESMOS
// dados da receita por campanha do CRM. SOMENTE LEITURA: só faz find (loadRevenueInputs) e grava
// arquivos locais. Não envia nada para o KAS nem para plataforma nenhuma: o envio é outro passo,
// com a CLI kas-attribution-import do kas-core.
//
// Uso:
//   node scripts/exportar-kas-attribution.mjs --amostra --saida ./kas-export
//       (amostra fictícia, sem banco: serve para conferir o formato)
//   node scripts/exportar-kas-attribution.mjs --uri-env CONSULTA_URI --desde 2026-11-01 --ate 2026-11-30 --saida ./kas-export
//       (lê o banco da variável de ambiente indicada; use um usuário só de leitura)
//
// Os arquivos têm telefone de paciente (só dígitos): trate como dado pessoal, não suba em
// repositório e apague depois do envio. No KAS o telefone vira impressão digital e não é guardado.
// No relatório do KAS, use from/to iguais a --desde/--ate para comparar com o CRM.
import fs from 'node:fs';
import path from 'node:path';
import { toKasInputs, toCsv, KAS_COLUMNS } from '../services/attribution/kasExport.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

function day(raw, end) {
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`data inválida: ${raw} (use AAAA-MM-DD)`);
  return new Date(`${raw}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

async function main() {
  const saida = arg('saida');
  if (!saida) throw new Error('informe --saida <pasta>');
  let raw;
  if (has('amostra')) {
    const { amostra } = await import('../services/attribution/fixtures/receitaFicticia.js');
    raw = { referenceEntries: [], ...amostra };
  } else {
    const uriEnv = arg('uri-env');
    const uri = uriEnv && process.env[uriEnv];
    if (!uri) throw new Error('informe --uri-env com o NOME de uma variável que tenha a conexão (usuário só de leitura)');
    const since = day(arg('desde'), false);
    const until = day(arg('ate'), true);
    if (!since || !until) throw new Error('informe --desde e --ate (AAAA-MM-DD)');
    const { default: mongoose } = await import('mongoose');
    await mongoose.connect(uri, { readPreference: 'secondaryPreferred', autoIndex: false, autoCreate: false });
    try {
      const { loadRevenueInputs } = await import('../services/attribution/revenueAttribution.js');
      raw = await loadRevenueInputs({ since, until });
    } finally {
      await mongoose.disconnect();
    }
  }
  const out = toKasInputs(raw);
  fs.mkdirSync(saida, { recursive: true, mode: 0o700 });
  for (const kind of Object.keys(KAS_COLUMNS)) {
    fs.writeFileSync(path.join(saida, `${kind}.csv`), toCsv(kind, out[kind]), { mode: 0o600 });
  }
  console.log(JSON.stringify({
    saida: path.resolve(saida),
    linhas: Object.fromEntries(Object.keys(KAS_COLUMNS).map((k) => [k, out[k].length])),
    ignorados: out.ignorados,
  }, null, 2));
}

main().catch((err) => {
  console.error('erro:', err.message);
  process.exit(1);
});

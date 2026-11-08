/**
 * 🤖 Geração de texto via API da Anthropic (Claude).
 * Usa fetch nativo (Node 18+) — SEM dependência nova. Aceita o formato de mensagens
 * no estilo OpenAI ([{role:'system'|'user'|'assistant', content}]) e converte para o
 * formato da Anthropic (system separado). Retorna a string de texto.
 *
 * Env necessárias (no .env local e no Render crm-worker):
 *   ANTHROPIC_API_KEY  → sua chave da Anthropic (obrigatória)
 *   ANTHROPIC_MODEL    → ID exato do modelo (ex.: o que aparece no seu console). Opcional; tem default.
 *
 * Em qualquer erro (sem chave, modelo inválido, rede, resposta vazia) a função LANÇA —
 * o chamador (generatePostForEspecialidade) já trata isso caindo no template de fallback.
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export async function gerarTextoIA(messages, { maxTokens = 450, temperature = 0.8, model } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY ausente — defina no .env/Render para usar Claude.');

  const modelo = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  // Converte do formato OpenAI → Anthropic (system vira parâmetro separado)
  const system = (messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const conv = (messages || [])
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: conv,
    }),
  });

  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${detalhe.slice(0, 200)}`);
  }

  const data = await resp.json();
  const out = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!out) throw new Error('Anthropic: resposta vazia');
  return out;
}

/**
 * services/agent/amanda/router.js
 *
 * Decide quem responde: FSM atual ou agente Claude.
 *
 *   AMANDA_AGENT_MODE=off     (padrão) só a FSM atual
 *   AMANDA_AGENT_MODE=shadow  FSM responde; Claude roda em paralelo sem escrever nada
 *                             e a sugestão vai para a coleção amandaagentshadows
 *   AMANDA_AGENT_MODE=on      Claude responde
 *
 *   AMANDA_AGENT_PHONES=5562999999999,5562888888888
 *     Opcional. Com "on", só esses números vão para o Claude (o resto segue na FSM).
 *     Com "shadow", só esses números rodam em sombra.
 */

export function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

export function phoneAllowed(phone, list = process.env.AMANDA_AGENT_PHONES) {
  const allowed = String(list || '')
    .split(',')
    .map(onlyDigits)
    .filter(Boolean);
  if (!allowed.length) return true;
  const p = onlyDigits(phone);
  if (!p) return false;
  // compara pelo final para tolerar com/sem 55 e nono dígito no prefixo
  return allowed.some((a) => p.endsWith(a.slice(-10)) || a.endsWith(p.slice(-10)));
}

/** @returns {'fsm'|'agent'|'shadow'} */
export function decideRoute(lead, env = process.env) {
  const mode = String(env.AMANDA_AGENT_MODE || 'off').toLowerCase();
  const phone = lead?.contact?.phone;
  if (mode === 'on') return phoneAllowed(phone, env.AMANDA_AGENT_PHONES) ? 'agent' : 'fsm';
  if (mode === 'shadow') return phoneAllowed(phone, env.AMANDA_AGENT_PHONES) ? 'shadow' : 'fsm';
  return 'fsm';
}

/**
 * Detecção de nomes "quase iguais" (erro de digitação) para checagem de paciente duplicado.
 *
 * Caso real que motivou isso: "Isaac Moreira Ribeiro" e "Issac Moreira Ribeiro" (um "s" a
 * mais) foram cadastrados como pacientes diferentes, mesmo com telefone e CPF idênticos,
 * porque a checagem de duplicidade exigia igualdade EXATA de string no nome — ~1 ano de
 * histórico clínico/financeiro ficou dividido em dois cadastros até ser detectado manualmente.
 */

const DIACRITICS_REGEX = new RegExp('[̀-ͯ]', 'g');

export function normalizeName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '');
}

/** Distância de Levenshtein clássica (DP O(n*m), nomes de paciente são curtos). */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prevRow = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let i = 1; i <= al; i++) {
    const currRow = [i];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,      // inserção
        prevRow[j] + 1,          // deleção
        prevRow[j - 1] + cost    // substituição
      );
    }
    prevRow = currRow;
  }
  return prevRow[bl];
}

/**
 * Considera dois nomes "a mesma pessoa provavelmente" quando, após normalização
 * (acentos/caixa/espaços), são idênticos ou diferem por no máximo `maxDistance`
 * edições — suficiente para pegar erros de digitação de 1 caractere (troca, falta,
 * letra a mais) sem confundir pessoas diferentes com nomes parecidos.
 */
export function isLikelySameName(nameA, nameB, maxDistance = 1) {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  return levenshteinDistance(a, b) <= maxDistance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trava única de paciente duplicado (03/11/2026)
//
// Caso que motivou: "BENJAMIN MARCAL BALDEZ" (sem telefone) e "Benjamin Marçal Baldez"
// (com telefone). A trava antiga só rodava quando o cadastro vinha COM telefone e o número
// era igual — sem telefone passava direto. E cada um dos caminhos que criam paciente
// (cadastro do ERP, agendamento com paciente novo, agenda externa, pré-agendamento,
// lead → paciente) conferia de um jeito diferente, alguns sem conferir nada.
//
// Todos passam a usar findPossibleDuplicates(). Níveis:
//   - 'forte': CPF igual, ou nome parecido + (mesmo nascimento OU mesmo telefone)
//   - 'nome' : só o nome parecido (sem acento/caixa, até 1 letra de diferença)
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT_CLASSES = {
  a: 'aáàâãä', e: 'eéèêë', i: 'iíìîï', o: 'oóòôõö', u: 'uúùûü', c: 'cç', n: 'nñ',
};

/** Regex (source) que casa a palavra com ou sem acento, em qualquer caixa (usar flag 'i'). */
export function accentInsensitivePattern(word) {
  return normalizeName(word)
    .split('')
    .map((ch) => {
      if (ACCENT_CLASSES[ch]) return `[${ACCENT_CLASSES[ch]}]`;
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
}

export function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

/** Compara telefones pelos últimos 10 dígitos (ignora 55 e o 9 extra do começo). */
export function isSamePhone(a, b) {
  const da = onlyDigits(a);
  const db = onlyDigits(b);
  if (da.length < 8 || db.length < 8) return false;
  const tail = (d) => d.slice(-8);
  return tail(da) === tail(db);
}

/** YYYY-MM-DD em UTC, tolerante a datas inválidas (retorna null). */
export function birthKey(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2200) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Procura cadastros que provavelmente são a mesma pessoa.
 *
 * @param {import('mongoose').Model} PatientModel
 * @param {{fullName?:string, dateOfBirth?:any, phone?:string, cpf?:string}} data
 * @param {{session?:any, excludeId?:string, limit?:number}} [opts]
 * @returns {Promise<Array<{_id:any, fullName:string, dateOfBirth:any, phone?:string, cpf?:string,
 *   healthPlan?:any, createdAt?:any, level:'forte'|'nome', reasons:string[]}>>}
 */
export async function findPossibleDuplicates(PatientModel, data = {}, opts = {}) {
  const { session = null, excludeId = null, limit = 5 } = opts;
  const fullName = (data.fullName || '').trim();
  const cpf = onlyDigits(data.cpf);
  const phone = onlyDigits(data.phone);
  const birth = birthKey(data.dateOfBirth);

  const or = [];
  if (cpf.length === 11) or.push({ cpf });
  if (phone.length >= 8) or.push({ phone: { $regex: `${phone.slice(-8)}$` } });
  const firstWord = normalizeName(fullName).split(' ')[0];
  if (firstWord && firstWord.length >= 2) {
    // candidatos pelo primeiro nome (com/sem acento); o filtro fino é feito em JS
    or.push({ fullName: { $regex: `^\\s*${accentInsensitivePattern(firstWord)}`, $options: 'i' } });
  }
  if (!or.length) return [];

  const filter = { $or: or };
  if (excludeId) filter._id = { $ne: excludeId };

  let q = PatientModel.find(filter)
    .select('fullName dateOfBirth phone cpf healthPlan createdAt source')
    .limit(500)
    .lean();
  if (session) q = q.session(session);
  const candidates = await q;

  const results = [];
  for (const p of candidates) {
    const reasons = [];
    let level = null;

    const sameCpf = cpf.length === 11 && onlyDigits(p.cpf) === cpf;
    const sameName = fullName && isLikelySameName(p.fullName, fullName);
    const sameBirth = birth && birthKey(p.dateOfBirth) === birth;
    const samePhone = phone.length >= 8 && isSamePhone(p.phone, phone);

    if (sameCpf) { level = 'forte'; reasons.push('CPF igual'); }
    if (sameName) {
      reasons.push(normalizeName(p.fullName) === normalizeName(fullName) ? 'mesmo nome' : 'nome quase igual');
      if (sameBirth) reasons.push('mesma data de nascimento');
      if (samePhone) reasons.push('mesmo telefone');
      if (sameBirth || samePhone) level = 'forte';
      else if (!level) level = 'nome';
    }
    if (!level) continue;

    results.push({ ...p, level, reasons });
  }

  results.sort((a, b) => (a.level === b.level ? 0 : a.level === 'forte' ? -1 : 1));
  return results.slice(0, limit);
}

/**
 * Para fluxos que não podem perguntar ao usuário (agenda, pré-agendamento, lead):
 * devolve o cadastro existente a reaproveitar quando há EXATAMENTE um match forte
 * por nome (+ nascimento/telefone) ou CPF. Senão null (o fluxo cria e marca possibleDuplicateOf).
 */
export function pickReusableDuplicate(duplicates = []) {
  const strong = duplicates.filter((d) => d.level === 'forte');
  return strong.length === 1 ? strong[0] : null;
}

/** Resumo enxuto para devolver ao front no 409 POSSIBLE_DUPLICATE. */
export function toDuplicateCandidateDTO(d) {
  return {
    _id: d._id?.toString?.() || d._id,
    fullName: d.fullName,
    dateOfBirth: birthKey(d.dateOfBirth),
    phone: d.phone || null,
    healthPlan: d.healthPlan?.name || null,
    createdAt: d.createdAt || null,
    level: d.level,
    reasons: d.reasons,
  };
}

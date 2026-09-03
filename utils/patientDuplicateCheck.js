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

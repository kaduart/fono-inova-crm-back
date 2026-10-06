/**
 * 💰 resolveConvenioSessionValue
 *
 * Valor de sessão de um convênio POR ESPECIALIDADE (tabela do convênio).
 *
 * Hierarquia:
 *   1. convenio.specialtyValues[especialidade].sessionValue  (tabela por especialidade)
 *   2. convenio.sessionValue                                  (valor padrão do convênio)
 *   3. 0
 *   + options.isAba: aplica convenio.abaSurchargePercent (opt-in; 0 = convênio sem ABA) sobre o valor acima
 *
 * Onde usar: SOMENTE ao decidir o valor de uma guia nova (ou fallback de legado quando
 * a guia não tem valor). Depois disso a fonte oficial é `InsuranceGuide.sessionValue`
 * (DOMAIN_INVARIANTS #21) — o valor é congelado na guia, então alterar a tabela do
 * convênio não muda guias já existentes.
 *
 * Função pura (sem I/O) — testável. Aceita doc Mongoose ou objeto simples.
 */

export function normalizeSpecialtyKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Adicional ABA é opt-in por convênio: só alguns convênios pagam. Sem configuração → 0 (sem adicional).
export const DEFAULT_ABA_SURCHARGE_PERCENT = 0;

/** Adicional ABA do convênio (%). Ausente/inválido/0 → sem adicional. */
export function isBaseConvenio(convenio) {
  return String(convenio?.code ?? '').trim().toLowerCase() === 'base';
}

export function getAbaSurchargePercent(convenio) {
  return isBaseConvenio(convenio) ? 50 : 0;
}

function legacyConfiguredPercent(convenio) {
  const pct = Number(convenio?.abaSurchargePercent);
  return Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_ABA_SURCHARGE_PERCENT;
}

/**
 * @param {object} convenio
 * @param {string} [specialty]
 * @param {{isAba?: boolean}} [options] isAba → base da especialidade + adicional ABA do convênio
 */
export function resolveConvenioSessionValue(convenio, specialty, options = {}) {
  if (!isBaseConvenio(convenio)) return Number(convenio?.sessionValue) || 0;
  const base = resolveBaseValue(convenio, specialty);
  if (!options?.isAba || base <= 0) return base;
  return Math.round(base * (1 + getAbaSurchargePercent(convenio) / 100) * 100) / 100;
}

/** Valor da AVALIAÇÃO por terapia (só convênio Base; ABA soma o mesmo adicional). 0 se não cadastrado. */
export function resolveConvenioEvaluationValue(convenio, specialty, options = {}) {
  if (!isBaseConvenio(convenio)) return 0;
  const key = normalizeSpecialtyKey(specialty);
  const entry = (convenio.specialtyValues || []).find(
    (e) => normalizeSpecialtyKey(e?.specialty) === key && Number(e?.evaluationValue) > 0
  );
  const base = entry ? Number(entry.evaluationValue) : 0;
  if (!options?.isAba || base <= 0) return base;
  return Math.round(base * (1 + getAbaSurchargePercent(convenio) / 100) * 100) / 100;
}

function resolveBaseValue(convenio, specialty) {
  if (!convenio) return 0;

  const key = normalizeSpecialtyKey(specialty);
  if (key && Array.isArray(convenio.specialtyValues)) {
    const entry = convenio.specialtyValues.find(
      (e) => normalizeSpecialtyKey(e?.specialty) === key && Number(e?.sessionValue) > 0
    );
    if (entry) return Number(entry.sessionValue);
  }

  return Number(convenio.sessionValue) || 0;
}

/**
 * Valida/normaliza a tabela recebida da API.
 * @returns {{ value?: Array<{specialty:string, sessionValue:number}>, error?: string }}
 */
export function sanitizeSpecialtyValues(input) {
  if (input === undefined) return { value: undefined };
  if (input === null) return { value: [] };
  if (!Array.isArray(input)) return { error: 'specialtyValues deve ser uma lista' };

  const seen = new Set();
  const value = [];
  for (const item of input) {
    const specialty = normalizeSpecialtyKey(item?.specialty);
    const sessionValue = Number(item?.sessionValue);
    const evaluationValue = item?.evaluationValue == null || item.evaluationValue === '' ? 0 : Number(item.evaluationValue);

    if (!specialty) return { error: 'Cada valor por especialidade precisa de uma especialidade' };
    if (!Number.isFinite(sessionValue) || sessionValue <= 0) {
      return { error: `Valor da especialidade "${specialty}" deve ser maior que zero` };
    }
    if (seen.has(specialty)) {
      return { error: `Especialidade "${specialty}" repetida na tabela de valores` };
    }
    if (!Number.isFinite(evaluationValue) || evaluationValue < 0) {
      return { error: `Valor de avaliação da especialidade "${specialty}" não pode ser negativo` };
    }
    seen.add(specialty);
    value.push({ specialty, sessionValue, evaluationValue });
  }
  return { value };
}

export default { resolveConvenioSessionValue, resolveConvenioEvaluationValue, getAbaSurchargePercent, sanitizeSpecialtyValues, normalizeSpecialtyKey };

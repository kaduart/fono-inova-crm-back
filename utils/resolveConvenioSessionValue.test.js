import { describe, it, expect } from 'vitest';
import { resolveConvenioSessionValue, sanitizeSpecialtyValues } from './resolveConvenioSessionValue.js';

// Tabela do convênio (exemplo da imagem: fono 70, psicoterapia individual 65, fisioterapia 55)
const convenio = {
  code: 'base',
  sessionValue: 80,
  specialtyValues: [
    { specialty: 'fonoaudiologia', sessionValue: 70 },
    { specialty: 'psicologia', sessionValue: 65 },
    { specialty: 'fisioterapia', sessionValue: 55 },
  ],
};

describe('resolveConvenioSessionValue', () => {
  it('usa o valor da especialidade quando existe na tabela', () => {
    expect(resolveConvenioSessionValue(convenio, 'fonoaudiologia')).toBe(70);
    expect(resolveConvenioSessionValue(convenio, 'fisioterapia')).toBe(55);
  });

  it('ignora caixa e espaços na especialidade', () => {
    expect(resolveConvenioSessionValue(convenio, '  Psicologia ')).toBe(65);
  });

  it('especialidade fora da tabela cai no valor padrão do convênio', () => {
    expect(resolveConvenioSessionValue(convenio, 'terapia_ocupacional')).toBe(80);
  });

  it('sem especialidade devolve o valor padrão (comportamento anterior)', () => {
    expect(resolveConvenioSessionValue(convenio)).toBe(80);
    expect(resolveConvenioSessionValue(convenio, null)).toBe(80);
  });

  it('convênio sem tabela se comporta como antes', () => {
    expect(resolveConvenioSessionValue({ code: 'base', sessionValue: 140 }, 'fonoaudiologia')).toBe(140);
    expect(resolveConvenioSessionValue({ sessionValue: 140, specialtyValues: [] }, 'fonoaudiologia')).toBe(140);
  });

  it('linha com valor zero/inválido é ignorada e cai no padrão', () => {
    const c = { code: 'base', sessionValue: 80, specialtyValues: [{ specialty: 'fonoaudiologia', sessionValue: 0 }] };
    expect(resolveConvenioSessionValue(c, 'fonoaudiologia')).toBe(80);
  });

  it('convênio inexistente → 0', () => {
    expect(resolveConvenioSessionValue(null, 'fonoaudiologia')).toBe(0);
    expect(resolveConvenioSessionValue(undefined)).toBe(0);
  });
});

describe('sanitizeSpecialtyValues', () => {
  it('undefined = não enviado (não altera); null = limpa a tabela', () => {
    expect(sanitizeSpecialtyValues(undefined)).toEqual({ value: undefined });
    expect(sanitizeSpecialtyValues(null)).toEqual({ value: [] });
  });

  it('normaliza especialidade e converte valor', () => {
    expect(sanitizeSpecialtyValues([{ specialty: ' Fonoaudiologia ', sessionValue: '70' }])).toEqual({
      value: [{ specialty: 'fonoaudiologia', sessionValue: 70, evaluationValue: 0 }],
    });
  });

  it.each([
    ['não é lista', 'abc', /lista/],
    ['sem especialidade', [{ sessionValue: 70 }], /especialidade/],
    ['valor zero', [{ specialty: 'fonoaudiologia', sessionValue: 0 }], /maior que zero/],
    ['valor negativo', [{ specialty: 'fonoaudiologia', sessionValue: -5 }], /maior que zero/],
    ['valor não numérico', [{ specialty: 'fonoaudiologia', sessionValue: 'x' }], /maior que zero/],
    [
      'especialidade repetida',
      [{ specialty: 'fonoaudiologia', sessionValue: 70 }, { specialty: 'Fonoaudiologia', sessionValue: 60 }],
      /repetida/,
    ],
  ])('rejeita: %s', (_nome, input, mensagem) => {
    expect(sanitizeSpecialtyValues(input).error).toMatch(mensagem);
  });
});

describe('adicional ABA (só convênio Base, 50% fixo)', () => {
  it('Base + ABA soma 50% sobre o valor da especialidade', () => {
    expect(resolveConvenioSessionValue(convenio, 'fonoaudiologia', { isAba: true })).toBe(105);
    expect(resolveConvenioSessionValue(convenio, 'psicologia', { isAba: true })).toBe(97.5);
  });
  it('isAba falso ou ausente não altera o valor', () => {
    expect(resolveConvenioSessionValue(convenio, 'fonoaudiologia', { isAba: false })).toBe(70);
    expect(resolveConvenioSessionValue(convenio, 'fonoaudiologia')).toBe(70);
  });
  it('outro convênio ignora ABA e tabela: usa só o valor padrão', () => {
    const outro = { code: 'unimed-anapolis', sessionValue: 140, specialtyValues: [{ specialty: 'fonoaudiologia', sessionValue: 70 }] };
    expect(resolveConvenioSessionValue(outro, 'fonoaudiologia', { isAba: true })).toBe(140);
  });
  it('sem valor base continua 0', () => {
    expect(resolveConvenioSessionValue({ code: 'base', sessionValue: 0 }, 'fonoaudiologia', { isAba: true })).toBe(0);
  });
});

describe('valor de avaliação por terapia (Base)', () => {
  const base = {
    code: 'base', sessionValue: 80,
    specialtyValues: [
      { specialty: 'fonoaudiologia', sessionValue: 70, evaluationValue: 200 },
      { specialty: 'fisioterapia', sessionValue: 55 },
    ],
  };
  it('nominal e ABA +50%', async () => {
    const { resolveConvenioEvaluationValue } = await import('./resolveConvenioSessionValue.js');
    expect(resolveConvenioEvaluationValue(base, 'fonoaudiologia')).toBe(200);
    expect(resolveConvenioEvaluationValue(base, 'fonoaudiologia', { isAba: true })).toBe(300);
  });
  it('sem valor cadastrado ou outro convênio → 0', async () => {
    const { resolveConvenioEvaluationValue } = await import('./resolveConvenioSessionValue.js');
    expect(resolveConvenioEvaluationValue(base, 'fisioterapia', { isAba: true })).toBe(0);
    expect(resolveConvenioEvaluationValue({ ...base, code: 'unimed' }, 'fonoaudiologia')).toBe(0);
  });
  it('sanitize aceita evaluationValue opcional e rejeita negativo', () => {
    expect(sanitizeSpecialtyValues([{ specialty: 'fonoaudiologia', sessionValue: 70, evaluationValue: '200' }]).value)
      .toEqual([{ specialty: 'fonoaudiologia', sessionValue: 70, evaluationValue: 200 }]);
    expect(sanitizeSpecialtyValues([{ specialty: 'fonoaudiologia', sessionValue: 70, evaluationValue: -1 }]).error).toMatch(/negativo/);
  });
});

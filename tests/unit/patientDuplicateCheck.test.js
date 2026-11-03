// Trava única de paciente duplicado (03/11/2026) — utils/patientDuplicateCheck.js
import { describe, it, expect } from 'vitest';
import {
  accentInsensitivePattern,
  birthKey,
  findPossibleDuplicates,
  isSamePhone,
  pickReusableDuplicate,
} from '../../utils/patientDuplicateCheck.js';

function fakeModel(rows) {
  return {
    find(filter) {
      const matches = rows.filter((p) => filter.$or.some((c) => {
        if (c.cpf) return p.cpf === c.cpf;
        if (c.phone) return new RegExp(c.phone.$regex).test(p.phone || '');
        if (c.fullName) return new RegExp(c.fullName.$regex, c.fullName.$options).test(p.fullName);
        return false;
      }));
      const q = { select: () => q, limit: () => q, session: () => q, lean: () => Promise.resolve(matches) };
      return q;
    },
  };
}

const BENJAMIN_SEM_TEL = { _id: 'a', fullName: 'BENJAMIN MARCAL BALDEZ', dateOfBirth: new Date('2020-05-01'), phone: '' };
const BENJAMIN_COM_TEL = { _id: 'b', fullName: 'Benjamin Marçal Baldez', dateOfBirth: new Date('2020-05-01'), phone: '62994811151' };
const IRMA = { _id: 'c', fullName: 'Alice Marçal Baldez', dateOfBirth: new Date('2018-01-01'), phone: '62994811151' };

describe('findPossibleDuplicates', () => {
  it('acha o mesmo nome sem acento/caixa mesmo sem telefone (caso Benjamin)', async () => {
    const r = await findPossibleDuplicates(fakeModel([BENJAMIN_SEM_TEL]), { fullName: 'Benjamin Marçal Baldez' });
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe('nome');
  });

  it('nome + nascimento = forte', async () => {
    const r = await findPossibleDuplicates(fakeModel([BENJAMIN_SEM_TEL]), { fullName: 'Benjamin Marcal Baldez', dateOfBirth: '2020-05-01' });
    expect(r[0].level).toBe('forte');
    expect(pickReusableDuplicate(r)?._id).toBe('a');
  });

  it('irmão com o mesmo telefone NÃO é duplicado', async () => {
    const r = await findPossibleDuplicates(fakeModel([IRMA]), { fullName: 'Benjamin Marçal Baldez', phone: '(62) 99481-1151' });
    expect(r).toHaveLength(0);
  });

  it('nome com 1 letra de diferença + telefone = forte', async () => {
    const r = await findPossibleDuplicates(fakeModel([BENJAMIN_COM_TEL]), { fullName: 'Benjamim Marçal Baldez', phone: '62994811151' });
    expect(r[0].level).toBe('forte');
  });

  it('dois cadastros fortes: não escolhe sozinho', async () => {
    const r = await findPossibleDuplicates(fakeModel([BENJAMIN_SEM_TEL, BENJAMIN_COM_TEL]), { fullName: 'Benjamin Marçal Baldez', dateOfBirth: '2020-05-01' });
    expect(r).toHaveLength(2);
    expect(pickReusableDuplicate(r)).toBeNull();
  });
});

describe('helpers', () => {
  it('regex sem acento', () => {
    expect(new RegExp(`^${accentInsensitivePattern('Marçal')}$`, 'i').test('MARCAL')).toBe(true);
  });
  it('telefone com e sem 55', () => {
    expect(isSamePhone('5562994811151', '(62) 99481-1151')).toBe(true);
  });
  it('data inválida não quebra', () => {
    expect(birthKey(new Date('20196-01-01'))).toBeNull();
    expect(birthKey('lixo')).toBeNull();
  });
});

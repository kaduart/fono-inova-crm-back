import { describe, expect, it } from 'vitest';
import { buildDpsId } from '../../services/fiscal/DpsIdentityService.js';

describe('DpsIdentityService.buildDpsId', () => {
  it('monta o identificador nacional de 45 posições para prestador CNPJ', () => {
    const id = buildDpsId({ municipioIBGE: '5201108', cnpj: '20.012.345/6780-01', serie: 1, nDPS: 42 });

    expect(id).toBe('DPS520110822001234567800100001000000000000042');
    expect(id).toHaveLength(45);
  });

  it('rejeita município e CNPJ inválidos', () => {
    expect(() => buildDpsId({ municipioIBGE: '123', cnpj: '20012345678001', serie: 1, nDPS: 1 }))
      .toThrow('DPS_MUNICIPIO_IBGE_INVALIDO');
    expect(() => buildDpsId({ municipioIBGE: '5201108', cnpj: '123', serie: 1, nDPS: 1 }))
      .toThrow('DPS_CNPJ_PRESTADOR_INVALIDO');
  });
});

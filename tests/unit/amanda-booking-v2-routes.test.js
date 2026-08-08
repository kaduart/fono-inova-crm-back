import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../services/amandaBookingService.js', import.meta.url),
  'utf8'
);

describe('Amanda booking — contrato HTTP V2', () => {
  it('não chama a rota V1 de appointments, que não está montada no servidor', () => {
    expect(source).not.toMatch(/api\.(?:post|get)\(\s*["'`]\/api\/appointments(?:[\/"'`])/);
  });

  it('cria pelos dois fluxos e relê o appointment usando rotas V2', () => {
    const creates = source.match(
      /api\.post\(\s*["'`]\/api\/v2\/appointments["'`]/g
    ) || [];

    expect(creates).toHaveLength(2);
    expect(source).toContain('api.get(`/api/v2/appointments/${appointmentId}`)');
  });
});

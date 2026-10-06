import { describe, it, expect, vi } from 'vitest';
import { buildErrorResponse } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';

// Contrato que a Agenda Externa lê (agenda/src/utils/apiError.js): code/errorCode/message/error + extras de topo.
describe('envelope de erro lido pela Agenda Externa', () => {
  it('erro de domínio com fields (rota de criação/edição/remarcação)', async () => {
    const err = Object.assign(new Error('Campos obrigatórios ausentes'), { status: 400, code: 'MISSING_DATE_TIME' });
    err.extra = { fields: { date: 'obrigatório' } };
    const { status, body } = await buildErrorResponse(err);
    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false, code: 'MISSING_DATE_TIME', errorCode: 'MISSING_DATE_TIME',
      message: 'Campos obrigatórios ausentes', error: 'Campos obrigatórios ausentes',
      fields: { date: 'obrigatório' },
    });
  });

  it('conflito de agenda preserva error curto legado, message útil e conflict', async () => {
    const err = new AppError('CONFLICT', 'Horário ocupado: Dra. Ana atende João às 09:00.', {
      status: 409, legacyError: 'Conflito de agenda médica', extra: { conflict: { type: 'doctor' } },
    });
    const { status, body } = await buildErrorResponse(err);
    expect(status).toBe(409);
    expect(body.error).toBe('Conflito de agenda médica');
    expect(body.message).toContain('Horário ocupado');
    expect(body.conflict).toEqual({ type: 'doctor' });
  });

  it('erro sem status vira 500 sem vazar código de sistema', async () => {
    const err = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    const { status, body } = await buildErrorResponse(err);
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});

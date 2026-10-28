import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { socketAuthMiddleware, verifySocketToken, getSocketAuthMode } from '../../config/socketAuth.js';

const saved = {};
const KEYS = ['SOCKET_AUTH_MODE', 'JWT_SECRET', 'ADMIN_API_TOKEN', 'AGENDA_EXPORT_TOKEN'];

function socket(auth = {}) {
  return { handshake: { auth, headers: { origin: 'http://test' }, query: {} }, data: {} };
}

beforeEach(() => {
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.JWT_SECRET = 'jwt-test';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  vi.restoreAllMocks();
});

const validJwt = () => jwt.sign({ id: '507f1f77bcf86cd799439011', role: 'admin' }, 'jwt-test');

describe('getSocketAuthMode', () => {
  it('padrão é warn e valores inválidos caem em warn', () => {
    expect(getSocketAuthMode()).toBe('warn');
    process.env.SOCKET_AUTH_MODE = 'ENFORCE';
    expect(getSocketAuthMode()).toBe('enforce');
    process.env.SOCKET_AUTH_MODE = 'xyz';
    expect(getSocketAuthMode()).toBe('warn');
  });
});

describe('verifySocketToken', () => {
  it('aceita JWT válido e token de serviço; recusa o resto', () => {
    process.env.AGENDA_EXPORT_TOKEN = 'agenda-tk';
    expect(verifySocketToken(validJwt())).toMatchObject({ ok: true, user: { role: 'admin' } });
    expect(verifySocketToken('agenda-tk')).toMatchObject({ ok: true, user: { role: 'service:agenda' } });
    expect(verifySocketToken('lixo')).toEqual({ ok: false, reason: 'invalid_token' });
    expect(verifySocketToken(null)).toEqual({ ok: false, reason: 'missing_token' });
    const expired = jwt.sign({ id: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, 'jwt-test');
    expect(verifySocketToken(expired)).toEqual({ ok: false, reason: 'token_expired' });
  });

  it('nunca aceita JWT assinado com o fallback "secreta" quando JWT_SECRET falta', () => {
    delete process.env.JWT_SECRET;
    const forged = jwt.sign({ id: 'x' }, 'secreta');
    expect(verifySocketToken(forged)).toEqual({ ok: false, reason: 'jwt_secret_unset' });
  });
});

describe('socketAuthMiddleware', () => {
  it('warn: aceita sem token', () => {
    const next = vi.fn();
    socketAuthMiddleware(socket(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('enforce: recusa sem token com erro unauthorized', () => {
    process.env.SOCKET_AUTH_MODE = 'enforce';
    const next = vi.fn();
    socketAuthMiddleware(socket(), next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('unauthorized');
  });

  it('enforce: aceita JWT válido e grava socket.data.user', () => {
    process.env.SOCKET_AUTH_MODE = 'enforce';
    const s = socket({ token: validJwt() });
    const next = vi.fn();
    socketAuthMiddleware(s, next);
    expect(next).toHaveBeenCalledWith();
    expect(s.data.user).toMatchObject({ role: 'admin' });
  });
});

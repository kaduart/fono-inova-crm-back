/**
 * 🧪 assertLoopbackOnlyDatabase — prova, com strings sintéticas (nenhuma conexão real é feita
 * nestes testes), que a trava de isolamento dos testes de integração fiscal:
 *   - aborta incondicionalmente para qualquer coisa que pareça produção, ANTES de qualquer
 *     mongoose.connect()/escrita;
 *   - permite normalmente um banco local efêmero (o padrão real usado pelo MongoMemoryReplSet).
 */
import { describe, it, expect } from 'vitest';
import { assertLoopbackOnlyDatabase } from '../fiscal/_guardAgainstProductionDb.js';

describe('assertLoopbackOnlyDatabase — banco de produção sempre aborta', () => {
  it('Atlas srv:// real (o mesmo formato do incidente com fono_inova_prod) é bloqueado', () => {
    expect(() => assertLoopbackOnlyDatabase(
      'mongodb+srv://usuario:senha@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority'
    )).toThrow(/FISCAL_INTEGRATION_TEST_BLOQUEADO/);
  });

  it('banco de produção sem a palavra "prod" no nome também é bloqueado (não é um blocklist de substring)', () => {
    expect(() => assertLoopbackOnlyDatabase(
      'mongodb+srv://usuario:senha@cluster0.g2c3sdk.mongodb.net/fono_inova?retryWrites=true'
    )).toThrow(/FISCAL_INTEGRATION_TEST_BLOQUEADO/);
  });

  it('host de rede interna (não-loopback) é bloqueado mesmo sem ser Atlas', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://10.0.0.5:27017/qualquer-coisa')).toThrow(/FISCAL_INTEGRATION_TEST_BLOQUEADO/);
  });

  it('hostname de rede (não IP/localhost) é bloqueado', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://mongo-prod.internal:27017/crm')).toThrow(/FISCAL_INTEGRATION_TEST_BLOQUEADO/);
  });

  it('múltiplos hosts onde só um não é loopback ainda é bloqueado (todo host precisa ser seguro)', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://127.0.0.1:27017,mongo-prod.internal:27017/crm?replicaSet=rs0')).toThrow(/FISCAL_INTEGRATION_TEST_BLOQUEADO/);
  });

  it('string vazia/ausente é bloqueada', () => {
    expect(() => assertLoopbackOnlyDatabase('')).toThrow();
    expect(() => assertLoopbackOnlyDatabase(undefined)).toThrow();
  });

  it('não existe variável de ambiente que libere o bloqueio (sem escape hatch)', () => {
    process.env.FISCAL_INTEGRATION_TESTS_ALLOW_THIS_DB = 'true';
    try {
      expect(() => assertLoopbackOnlyDatabase(
        'mongodb+srv://usuario:senha@cluster0.g2c3sdk.mongodb.net/fono_inova_prod'
      )).toThrow(/FISCAL_INTEGRATION_TEST_BLOQUEADO/);
    } finally {
      delete process.env.FISCAL_INTEGRATION_TESTS_ALLOW_THIS_DB;
    }
  });
});

describe('assertLoopbackOnlyDatabase — banco de teste local funciona normalmente', () => {
  it('127.0.0.1 (formato real devolvido por MongoMemoryReplSet.getUri()) passa', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://127.0.0.1:54321/?replicaSet=testset')).not.toThrow();
  });

  it('replica set com múltiplos hosts 127.0.0.1 passa', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://127.0.0.1:54321,127.0.0.1:54322,127.0.0.1:54323/?replicaSet=testset')).not.toThrow();
  });

  it('localhost passa', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://localhost:27017/teste')).not.toThrow();
  });

  it('IPv6 loopback (::1) passa', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://[::1]:27017/teste')).not.toThrow();
  });

  it('usuário/senha no formato local não confundem a extração de host', () => {
    expect(() => assertLoopbackOnlyDatabase('mongodb://usuario:senha@127.0.0.1:27017/teste')).not.toThrow();
  });
});

/**
 * 🧪 Testes unitários - FiscalStateMachineService
 *
 * Cobre a matriz oficial de eventos (Anexo II, event_matrix.md) na parte determinística
 * (família de cancelamento) + o tratamento de manifestações como trilha paralela + bloqueio/
 * desbloqueio por ofício. Funções puras — sem banco, sem mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  reconstructState,
  validateIncomingEvent
} from '../../domain/fiscal/stateMachine/FiscalStateMachineService.js';
import { TipoEvento } from '../../constants/fiscalEvents.js';
import { FiscalInvoiceStatus } from '../../constants/fiscalEnums.js';

function evt(tipoEvento, extra = {}) {
  return { tipoEvento, occurredAt: new Date(), ...extra };
}

describe('FiscalStateMachineService.reconstructState', () => {
  it('emissão simples: sem eventos → status AUTHORIZED', () => {
    const state = reconstructState([]);
    expect(state.status).toBe(FiscalInvoiceStatus.AUTHORIZED);
    expect(state.blockedEventTypes.size).toBe(0);
    expect(state.manifestations).toHaveLength(0);
  });

  it('cancelamento simples → status CANCELLED', () => {
    const state = reconstructState([evt(TipoEvento.CANCELAMENTO)]);
    expect(state.status).toBe(FiscalInvoiceStatus.CANCELLED);
  });

  it('cancelamento por substituição → status CANCELLED_SUBSTITUTED', () => {
    const state = reconstructState([evt(TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO)]);
    expect(state.status).toBe(FiscalInvoiceStatus.CANCELLED_SUBSTITUTED);
  });

  it('solicitação de análise fiscal → PENDING_FISCAL_ANALYSIS', () => {
    const state = reconstructState([evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO)]);
    expect(state.status).toBe(FiscalInvoiceStatus.PENDING_FISCAL_ANALYSIS);
  });

  it('análise fiscal deferida → CANCELLED (terminal)', () => {
    const state = reconstructState([
      evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO),
      evt(TipoEvento.CANCELAMENTO_DEFERIDO_ANALISE_FISCAL)
    ]);
    expect(state.status).toBe(FiscalInvoiceStatus.CANCELLED);
  });

  it('análise fiscal indeferida → volta a AUTHORIZED (não terminal)', () => {
    const state = reconstructState([
      evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO),
      evt(TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL)
    ]);
    expect(state.status).toBe(FiscalInvoiceStatus.AUTHORIZED);
  });

  it('cancelamento por ofício após indeferido → CANCELLED', () => {
    const state = reconstructState([
      evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO),
      evt(TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL),
      evt(TipoEvento.CANCELAMENTO_POR_OFICIO)
    ]);
    expect(state.status).toBe(FiscalInvoiceStatus.CANCELLED);
  });

  it('manifestações não alteram status (trilha paralela)', () => {
    const state = reconstructState([
      evt(TipoEvento.MANIFESTACAO_CONFIRMACAO_PRESTADOR),
      evt(TipoEvento.MANIFESTACAO_REJEICAO_TOMADOR),
      evt(TipoEvento.MANIFESTACAO_ANULACAO_REJEICAO)
    ]);
    expect(state.status).toBe(FiscalInvoiceStatus.AUTHORIZED);
    expect(state.manifestations).toHaveLength(3);
  });

  it('bloqueio por ofício marca o tipoEvento-alvo como bloqueado', () => {
    const state = reconstructState([
      evt(TipoEvento.BLOQUEIO_POR_OFICIO, { targetTipoEvento: TipoEvento.CANCELAMENTO })
    ]);
    expect(state.blockedEventTypes.has(TipoEvento.CANCELAMENTO)).toBe(true);
  });

  it('desbloqueio remove o tipoEvento-alvo do conjunto bloqueado', () => {
    const state = reconstructState([
      evt(TipoEvento.BLOQUEIO_POR_OFICIO, { targetTipoEvento: TipoEvento.CANCELAMENTO }),
      evt(TipoEvento.DESBLOQUEIO_POR_OFICIO, { targetTipoEvento: TipoEvento.CANCELAMENTO })
    ]);
    expect(state.blockedEventTypes.has(TipoEvento.CANCELAMENTO)).toBe(false);
  });

  it('replay/reconstrução: mesma lista de eventos produz sempre o mesmo estado (idempotência de leitura)', () => {
    const events = [
      evt(TipoEvento.MANIFESTACAO_CONFIRMACAO_TOMADOR),
      evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO),
      evt(TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL)
    ];
    const state1 = reconstructState(events);
    const state2 = reconstructState(events);
    expect(state1.status).toBe(state2.status);
    expect(state1.lastCancellationFamilyEvent).toBe(state2.lastCancellationFamilyEvent);
  });
});

describe('FiscalStateMachineService.validateIncomingEvent', () => {
  it('permite Cancelamento a partir do estado inicial', () => {
    const state = reconstructState([]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.CANCELAMENTO });
    expect(result.allowed).toBe(true);
  });

  it('rejeita qualquer evento após estado terminal (Cancelamento)', () => {
    const state = reconstructState([evt(TipoEvento.CANCELAMENTO)]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.MANIFESTACAO_CONFIRMACAO_PRESTADOR });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('FISCAL_INVOICE_TERMINAL_STATE');
  });

  it('rejeita segunda Solicitação de Análise Fiscal (idempotência de transição)', () => {
    const state = reconstructState([evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO)]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO });
    expect(result.allowed).toBe(false);
  });

  it('rejeita nova Solicitação de Análise Fiscal após Indeferido', () => {
    const state = reconstructState([
      evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO),
      evt(TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL)
    ]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO });
    expect(result.allowed).toBe(false);
  });

  it('permite Cancelamento por Ofício após Indeferido', () => {
    const state = reconstructState([
      evt(TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO),
      evt(TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL)
    ]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.CANCELAMENTO_POR_OFICIO });
    expect(result.allowed).toBe(true);
  });

  it('rejeita Cancelamento quando o tipo está bloqueado por ofício', () => {
    const state = reconstructState([
      evt(TipoEvento.BLOQUEIO_POR_OFICIO, { targetTipoEvento: TipoEvento.CANCELAMENTO })
    ]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.CANCELAMENTO });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('TIPO_EVENTO_BLOQUEADO_POR_OFICIO');
  });

  it('rejeita bloqueio duplicado sobre o mesmo alvo', () => {
    const state = reconstructState([
      evt(TipoEvento.BLOQUEIO_POR_OFICIO, { targetTipoEvento: TipoEvento.CANCELAMENTO })
    ]);
    const result = validateIncomingEvent(state, {
      tipoEvento: TipoEvento.BLOQUEIO_POR_OFICIO,
      targetTipoEvento: TipoEvento.CANCELAMENTO
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('TARGET_JA_BLOQUEADO');
  });

  it('rejeita desbloqueio sem bloqueio pendente correspondente', () => {
    const state = reconstructState([]);
    const result = validateIncomingEvent(state, {
      tipoEvento: TipoEvento.DESBLOQUEIO_POR_OFICIO,
      targetTipoEvento: TipoEvento.CANCELAMENTO
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NAO_HA_BLOQUEIO_PENDENTE_PARA_ESSE_ALVO');
  });

  it('permite manifestação mesmo com histórico de outras manifestações', () => {
    const state = reconstructState([evt(TipoEvento.MANIFESTACAO_CONFIRMACAO_PRESTADOR)]);
    const result = validateIncomingEvent(state, { tipoEvento: TipoEvento.MANIFESTACAO_REJEICAO_TOMADOR });
    expect(result.allowed).toBe(true);
  });

  it('rejeita tipoEvento não catalogado', () => {
    const state = reconstructState([]);
    const result = validateIncomingEvent(state, { tipoEvento: 999999 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('TIPO_EVENTO_NAO_CATALOGADO');
  });
});

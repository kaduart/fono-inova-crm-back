/**
 * 🧪 AnapolisMunicipalAdapter.reconcileDps — orquestração da consulta ConsultarNfsePorDps
 * (manual v1.01 §9.2.6). Não faz HTTP real (mesmo critério de fiscalProviderLayer.test.js):
 * `_request` é substituído por um stub no próprio teste.
 */
import { describe, it, expect, vi } from 'vitest';
import { AnapolisMunicipalAdapter } from '../../adapters/fiscal/AnapolisMunicipalAdapter.js';

const fiscalProfile = { cnpj: '12345678000199', inscricaoMunicipal: '142' };

function buildAdapter() {
  return new AnapolisMunicipalAdapter({ fiscalProfile });
}

describe('AnapolisMunicipalAdapter.reconcileDps', () => {
  it('sem serie/nDPS nunca chama o provedor', async () => {
    const adapter = buildAdapter();
    adapter._request = vi.fn();
    const result = await adapter.reconcileDps({});
    expect(result).toMatchObject({ status: 'unknown', reason: 'DPS_IDENTITY_MISSING' });
    expect(adapter._request).not.toHaveBeenCalled();
  });

  it('sem CNPJ/IM no perfil nunca chama o provedor', async () => {
    const adapter = new AnapolisMunicipalAdapter({ fiscalProfile: {} });
    adapter._request = vi.fn();
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result).toMatchObject({ status: 'unknown', reason: 'NOTA_CONTROL_IDENTIDADE_PRESTADOR_INDISPONIVEL' });
    expect(adapter._request).not.toHaveBeenCalled();
  });

  it('DPS autorizada encontrada: authorized com fields completos, nunca reenvia', async () => {
    const adapter = buildAdapter();
    const body = '<ConsultarNfsePorDpsResult>&lt;CompNfse&gt;&lt;NFSe&gt;&lt;infNFSe id="chaveXYZ"&gt;&lt;cStat&gt;100&lt;/cStat&gt;&lt;nNFSe&gt;99&lt;/nNFSe&gt;&lt;/infNFSe&gt;&lt;/NFSe&gt;&lt;/CompNfse&gt;</ConsultarNfsePorDpsResult>';
    adapter._request = vi.fn().mockResolvedValue({ status: 200, body, diagnostics: { httpStatus: 200 } });
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result.status).toBe('authorized');
    expect(result.fields).toMatchObject({ chaveAcesso: 'chaveXYZ', nNFSe: 99, cStat: 100 });
    expect(adapter._request).toHaveBeenCalledTimes(1);
    const [, operation] = adapter._request.mock.calls[0];
    expect(operation).toBe('ConsultarNfsePorDps');
  });

  it('processamento ainda em andamento (mensagem não reconhecida) fica unknown, nunca autoriza reenvio', async () => {
    const adapter = buildAdapter();
    const body = '<ConsultarNfsePorDpsResult>&lt;ListaMensagemRetorno&gt;&lt;MensagemRetorno&gt;&lt;Codigo&gt;E001&lt;/Codigo&gt;&lt;Mensagem&gt;Lote em processamento&lt;/Mensagem&gt;&lt;/MensagemRetorno&gt;&lt;/ListaMensagemRetorno&gt;</ConsultarNfsePorDpsResult>';
    adapter._request = vi.fn().mockResolvedValue({ status: 200, body, diagnostics: {} });
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result.status).toBe('unknown');
  });

  it('DPS rejeitada na origem não é reproduzível por esta consulta (documentado): fica unknown, não authorized nem not_found por engano', async () => {
    // O manual não descreve um estado "rejeitada" consultável por ConsultarNfsePorDps no fluxo
    // síncrono — uma rejeição acontece inline na resposta original de RecepcionarLoteDpsSincrono,
    // nunca fica persistida para consulta posterior. Uma mensagem de erro genérica deve permanecer
    // 'unknown', nunca ser interpretada silenciosamente como sucesso.
    const adapter = buildAdapter();
    const body = '<ConsultarNfsePorDpsResult>&lt;ListaMensagemRetorno&gt;&lt;MensagemRetorno&gt;&lt;Codigo&gt;E500&lt;/Codigo&gt;&lt;Mensagem&gt;Erro ao processar consulta&lt;/Mensagem&gt;&lt;/MensagemRetorno&gt;&lt;/ListaMensagemRetorno&gt;</ConsultarNfsePorDpsResult>';
    adapter._request = vi.fn().mockResolvedValue({ status: 200, body, diagnostics: {} });
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result.status).toBe('unknown');
  });

  it('DPS "não encontrada" fica unknown (endurecido 2026-09-11, não é mais um status próprio) — e o adapter nunca chama submitDps sozinho', async () => {
    // Sem amostra real de homologação confirmando a semântica de "não encontrado" no fluxo
    // síncrono, essa mensagem não pode ser tratada como sinal de que é seguro reenviar — vira
    // unknown, igual a qualquer outra resposta não reconhecida. O texto some no `reason`, nunca
    // no `status`, especificamente para que nada no código possa decidir "retry" olhando só o
    // status.
    const adapter = buildAdapter();
    adapter.submitDps = vi.fn();
    const body = '<ConsultarNfsePorDpsResult>&lt;ListaMensagemRetorno&gt;&lt;MensagemRetorno&gt;&lt;Codigo&gt;E404&lt;/Codigo&gt;&lt;Mensagem&gt;DPS não encontrado na base de dados&lt;/Mensagem&gt;&lt;/MensagemRetorno&gt;&lt;/ListaMensagemRetorno&gt;</ConsultarNfsePorDpsResult>';
    adapter._request = vi.fn().mockResolvedValue({ status: 200, body, diagnostics: {} });
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('NAO_ENCONTRADO_NAO_CONFIRMADO');
    expect(adapter.submitDps).not.toHaveBeenCalled();
  });

  it('HTTP não-2xx na consulta vira unknown com diagnostics preservado', async () => {
    const adapter = buildAdapter();
    adapter._request = vi.fn().mockResolvedValue({ status: 500, body: 'erro interno', diagnostics: { httpStatus: 500 } });
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result).toMatchObject({ status: 'unknown', reason: 'NOTA_CONTROL_CONSULTA_HTTP_500' });
  });

  it('timeout na consulta nunca lança — vira unknown com diagnostics preservado quando disponível', async () => {
    const adapter = buildAdapter();
    const timeoutError = Object.assign(new Error('Timeout na Nota Control'), {
      isTimeout: true,
      diagnostics: { endpoint: 'x', response: 'timeout' }
    });
    adapter._request = vi.fn().mockRejectedValue(timeoutError);
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result).toMatchObject({ status: 'unknown', reason: 'NOTA_CONTROL_CONSULTA_TIMEOUT' });
    expect(result.diagnostics).toBeTruthy();
  });

  it('erro de rede genérico (não timeout) na consulta também nunca lança', async () => {
    const adapter = buildAdapter();
    adapter._request = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await adapter.reconcileDps({ serie: 1, nDPS: 42 });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('ECONNRESET');
  });
});

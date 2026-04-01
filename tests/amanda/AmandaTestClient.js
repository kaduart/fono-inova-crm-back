// back/tests/amanda/AmandaTestClient.js
/**
 * Amanda Test Client
 * 
 * Cliente de teste para Amanda que permite:
 * - Processamento síncrono (determinístico)
 * - Isolamento de estado entre testes
 * - Rastreamento de eventos
 * - Contracts testing
 * 
 * Usage:
 *   const client = new AmandaTestClient({ mode: 'sync' });
 *   const result = await client.sendMessage({ message: "quero agendar" });
 *   expect(result.intent).toBe("AGENDAMENTO");
 */

import { processMessageSync } from './amandaTestMode.js';

export class AmandaTestClient {
  constructor(options = {}) {
    this.mode = options.mode || 'sync'; // 'sync' | 'async'
    this.trackEvents = options.trackEvents !== false;
    this.events = [];
    this.leadContext = options.leadContext || {};
    this.conversationHistory = [];
  }

  /**
   * Envia mensagem para Amanda (modo síncrono em teste)
   * @param {Object} params
   * @param {string} params.message - Mensagem do usuário
   * @param {Object} params.context - Contexto adicional do lead
   * @param {string} params.expectedIntent - Intent esperado (para validação)
   * @returns {Promise<AmandaResponse>}
   */
  async sendMessage(params) {
    const { message, context = {}, expectedIntent } = params;
    
    // Merge context
    const fullContext = {
      ...this.leadContext,
      ...context,
      conversationHistory: this.conversationHistory
    };

    let result;
    
    if (this.mode === 'sync') {
      // Processamento síncrono determinístico
      result = await processMessageSync(message, fullContext);
    } else {
      // Modo async (mais próximo da produção, mas menos determinístico)
      result = await this._processAsync(message, fullContext);
    }

    // Tracking
    if (this.trackEvents) {
      this.events.push({
        timestamp: new Date().toISOString(),
        input: message,
        output: result,
        expectedIntent
      });
    }

    // Atualiza história
    this.conversationHistory.push({
      role: 'user',
      content: message
    });
    this.conversationHistory.push({
      role: 'assistant',
      content: result.response
    });

    // Validação de intent (contract test)
    if (expectedIntent && result.intent !== expectedIntent) {
      const error = new Error(
        `Intent mismatch: expected "${expectedIntent}", got "${result.intent}"`
      );
      error.code = 'INTENT_MISMATCH';
      error.expected = expectedIntent;
      error.actual = result.intent;
      error.input = message;
      throw error;
    }

    return result;
  }

  /**
   * Envia múltiplas mensagens em sequência (conversação)
   * @param {Array<{message: string, expectedIntent?: string}>} messages
   * @returns {Promise<Array<AmandaResponse>>}
   */
  async sendConversation(messages) {
    const results = [];
    for (const msg of messages) {
      const result = await this.sendMessage(msg);
      results.push(result);
    }
    return results;
  }

  /**
   * Reseta estado do cliente (isolation entre testes)
   */
  reset() {
    this.events = [];
    this.conversationHistory = [];
    this.leadContext = {};
  }

  /**
   * Obtém métricas dos testes executados
   */
  getMetrics() {
    const intents = this.events.map(e => e.output.intent);
    const uniqueIntents = [...new Set(intents)];
    
    return {
      totalMessages: this.events.length,
      uniqueIntents: uniqueIntents.length,
      intentDistribution: intents.reduce((acc, intent) => {
        acc[intent] = (acc[intent] || 0) + 1;
        return acc;
      }, {}),
      errors: this.events.filter(e => e.output.error).length
    };
  }

  /**
   * Exporta relatório de teste
   */
  exportReport() {
    return {
      timestamp: new Date().toISOString(),
      mode: this.mode,
      metrics: this.getMetrics(),
      events: this.events,
      conversationHistory: this.conversationHistory
    };
  }

  async _processAsync(message, context) {
    // Fallback para modo async (usado em E2E)
    // Importa dinamicamente para não quebrar em modo sync
    const { default: getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
    return getOptimizedAmandaResponse(message, context);
  }
}

/**
 * Helper para criar teste de contrato simples
 * @param {string} description - Descrição do teste
 * @param {Object} params
 * @param {string} params.message - Input
 * @param {string} params.expectedIntent - Intent esperado
 * @param {Function} params.additionalChecks - Verificações adicionais
 */
export function contractTest(description, params) {
  const { message, expectedIntent, additionalChecks, context = {} } = params;
  
  return {
    description,
    run: async () => {
      const client = new AmandaTestClient({ mode: 'sync' });
      try {
        const result = await client.sendMessage({ 
          message, 
          context, 
          expectedIntent 
        });
        
        if (additionalChecks) {
          await additionalChecks(result, client);
        }
        
        return { success: true, result };
      } catch (error) {
        return { 
          success: false, 
          error: error.message,
          code: error.code,
          input: message,
          expected: error.expected,
          actual: error.actual
        };
      }
    }
  };
}

export default AmandaTestClient;

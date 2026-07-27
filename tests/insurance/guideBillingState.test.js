// tests/insurance/guideBillingState.test.js
/**
 * deriveGuideBillingState() — máquina de estados de faturamento da guia.
 *
 * Regressão real 2026-07-27 (guia 16145509, Benjamim Rocha Simão): guia com
 * sessões de um ciclo de faturamento anterior já batched e sessões novas
 * ainda pendentes virava BILLED e sumia das abas "A Faturar"/"Aguardando
 * Faturamento", mesmo com R$ 1.120 em sessões reais aguardando ação. O mesmo
 * bug existia para RECEIVED. Ver services/insuranceBatchGuideAdapter.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import '../../models/index.js';
import { deriveGuideBillingState, GuideBillingState } from '../../services/insuranceBatchGuideAdapter.js';

describe('🏥 deriveGuideBillingState()', () => {
    it('guia nunca faturada -> PENDING', () => {
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: false,
            hasBilledSession: false,
            hasReceivedPayment: false,
            isClosed: false,
            hasPendingSessions: true
        });
        assert.strictEqual(state, GuideBillingState.PENDING);
    });

    it('guia nunca faturada mas com documentação já enviada -> DOCUMENTATION_SENT', () => {
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: true,
            hasBilledSession: false,
            hasReceivedPayment: false,
            isClosed: false,
            hasPendingSessions: true
        });
        assert.strictEqual(state, GuideBillingState.DOCUMENTATION_SENT);
    });

    it('guia parcialmente faturada (sobram sessões pendentes) -> PENDING, não BILLED', () => {
        // caso Benjamim: 2 sessões já em lote, 14 sessões novas pendentes
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: false,
            hasBilledSession: true,
            hasReceivedPayment: false,
            isClosed: false,
            hasPendingSessions: true
        });
        assert.strictEqual(state, GuideBillingState.PENDING);
    });

    it('guia parcialmente faturada e já recebida em ciclo anterior, mas com sessão nova pendente -> PENDING, não RECEIVED', () => {
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: false,
            hasBilledSession: true,
            hasReceivedPayment: true,
            isClosed: false,
            hasPendingSessions: true
        });
        assert.strictEqual(state, GuideBillingState.PENDING);
    });

    it('guia totalmente faturada, nada pendente -> BILLED', () => {
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: false,
            hasBilledSession: true,
            hasReceivedPayment: false,
            isClosed: false,
            hasPendingSessions: false
        });
        assert.strictEqual(state, GuideBillingState.BILLED);
    });

    it('guia recebida do convênio, nada pendente -> RECEIVED', () => {
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: false,
            hasBilledSession: true,
            hasReceivedPayment: true,
            isClosed: false,
            hasPendingSessions: false
        });
        assert.strictEqual(state, GuideBillingState.RECEIVED);
    });

    it('guia encerrada -> CLOSED, mesmo com sessão pendente (fechamento é definitivo)', () => {
        const state = deriveGuideBillingState({}, {
            hasSentCommunication: false,
            hasBilledSession: false,
            hasReceivedPayment: false,
            isClosed: true,
            hasPendingSessions: true
        });
        assert.strictEqual(state, GuideBillingState.CLOSED);
    });
});

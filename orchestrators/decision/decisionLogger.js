/**
 * Decision Logger — Telemetria do DecisionResolver
 *
 * Registra cada decisão com: action, domain, score, reason, flags ativas, latência.
 * Usa o logger padrão (JSON structured) para ser capturável por qualquer sink
 * (console, arquivo, DataDog, etc.) sem acoplamento.
 */

import logger from '../../utils/logger.js';
import { recordDecision } from './decisionMetricsService.js';

/**
 * @param {Object} params
 * @param {string}  params.leadId
 * @param {string}  params.text          — primeiros 80 chars do input
 * @param {Object}  params.flags         — flags detectadas pelo detectAllFlags
 * @param {Object}  params.decision      — resultado do resolveDecision()
 * @param {number}  params.latencyMs
 * @param {string}  [params.currentState]
 */
export function logDecision({ leadId, text, flags, decision, latencyMs, currentState }) {
  const activeFlags = flags ? Object.entries(flags)
    .filter(([, v]) => v === true)
    .map(([k]) => k) : [];

  const confidence = decision.systemConfidence != null
    ? parseFloat(decision.systemConfidence.toFixed(3))
    : null;

  logger.info('[DecisionResolver] decision', {
    leadId: leadId?.toString(),
    currentState: currentState || 'unknown',
    action:      decision.action,
    domain:      decision.domain || null,
    confidence,
    reason:      decision.reason || null,
    activeFlags,
    inputSnippet: typeof text === 'string' ? text.substring(0, 80) : null,
    latencyMs:   latencyMs ?? null,
  });

  // Alimenta o agregador em memória (sem await — síncrono)
  recordDecision({
    action:     decision.action,
    domain:     decision.domain || null,
    confidence,
    activeFlags,
    latencyMs:  latencyMs ?? null,
  });
}

export default logDecision;

// back/infra/observability/index.js
/**
 * Observability Module
 * 
 * Exporta todas as ferramentas de observabilidade:
 * - Tracing (correlationId, spans)
 * - Event Debugger (timeline, gaps, performance)
 * - Metrics (a ser implementado)
 */

export { 
  getCorrelationId, 
  createTracingContext, 
  propagateContext,
  trackEvent,
  getEventTimeline,
  renderTimeline,
  startSpan
} from './tracing.js';

export { EventDebugger } from './eventDebugger.js';

// Re-exporta logger estruturado
export { logger } from '../logger.js';

// back/infra/observability/tracing.js
/**
 * Distributed Tracing System
 * 
 * Sistema de tracing distribuído para rastreamento ponta a ponta
 * de eventos através dos domínios.
 * 
 * Features:
 * - CorrelationId obrigatório em todos os eventos
 * - Span tracking (início/fim de operações)
 * - Event timeline por correlationId
 * - Performance metrics
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger.js';

// ============================================
// CORRELATION ID MANAGEMENT
// ============================================

const asyncLocalStorage = new Map();

/**
 * Gera ou recupera correlationId
 * 
 * Regra: TODOS eventos DEVEM ter correlationId
 * - Se não fornecido: gera novo
 * - Se fornecido: propaga
 * - Se evento de resposta: mantém mesmo correlationId
 */
export function getCorrelationId(context = {}) {
  // 1. Verifica contexto atual
  if (context.correlationId) {
    return context.correlationId;
  }

  // 2. Verifica async local storage (se implementado)
  const stored = asyncLocalStorage.get('correlationId');
  if (stored) {
    return stored;
  }

  // 3. Gera novo
  return generateCorrelationId();
}

function generateCorrelationId() {
  return `${Date.now()}_${uuidv4().split('-')[0]}`;
}

/**
 * Cria contexto de tracing para um novo fluxo
 */
export function createTracingContext(domain, operation, metadata = {}) {
  const correlationId = generateCorrelationId();
  const spanId = generateSpanId();
  
  const context = {
    correlationId,
    spanId,
    domain,
    operation,
    startedAt: Date.now(),
    metadata: {
      ...metadata,
      nodeVersion: process.version,
      pid: process.pid
    }
  };

  // Log de início de operação
  logger.info(`[${domain}] Operation started`, {
    correlationId,
    spanId,
    operation,
    ...metadata
  });

  return context;
}

/**
 * Propaga contexto para operação filha
 */
export function propagateContext(parentContext, childOperation, metadata = {}) {
  return {
    correlationId: parentContext.correlationId,
    parentSpanId: parentContext.spanId,
    spanId: generateSpanId(),
    domain: parentContext.domain,
    operation: childOperation,
    startedAt: Date.now(),
    metadata: {
      ...parentContext.metadata,
      ...metadata,
      parentOperation: parentContext.operation
    }
  };
}

function generateSpanId() {
  return `span_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================
// EVENT TRACKING
// ============================================

/**
 * Registra evento no timeline
 */
export async function trackEvent(eventStore, eventData) {
  const {
    correlationId,
    eventType,
    domain,
    payload = {},
    metadata = {}
  } = eventData;

  if (!correlationId) {
    throw new Error('CorrelationId is REQUIRED for all events');
  }

  const trackingEntry = {
    correlationId,
    eventType,
    domain,
    timestamp: new Date(),
    payloadKeys: Object.keys(payload),
    payloadSize: JSON.stringify(payload).length,
    metadata: {
      ...metadata,
      nodeEnv: process.env.NODE_ENV,
      service: process.env.SERVICE_NAME || 'crm'
    }
  };

  // Salva no event store de tracing (coleção separada)
  try {
    await eventStore.create(trackingEntry);
  } catch (error) {
    logger.error('Failed to track event', { error: error.message, correlationId });
    // Não falha a operação principal - tracing é best-effort
  }

  return trackingEntry;
}

// ============================================
// TIMELINE QUERY
// ============================================

/**
 * Recupera timeline completa de um correlationId
 */
export async function getEventTimeline(eventStore, correlationId) {
  const events = await eventStore
    .find({ correlationId })
    .sort({ timestamp: 1 })
    .lean();

  return {
    correlationId,
    totalEvents: events.length,
    duration: events.length > 1 
      ? events[events.length - 1].timestamp - events[0].timestamp
      : 0,
    domains: [...new Set(events.map(e => e.domain))],
    events: events.map(e => ({
      timestamp: e.timestamp,
      domain: e.domain,
      eventType: e.eventType,
      payloadKeys: e.payloadKeys
    }))
  };
}

/**
 * Gera visualização ASCII da timeline
 */
export function renderTimeline(timeline) {
  const lines = [];
  
  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════╗');
  lines.push(`║  EVENT TIMELINE: ${timeline.correlationId.substring(0, 30).padEnd(30)} ║`);
  lines.push('╠════════════════════════════════════════════════════════════╣');
  lines.push(`║  Duration: ${String(timeline.duration).padEnd(10)}ms                            ║`);
  lines.push(`║  Events: ${String(timeline.totalEvents).padEnd(10)}                               ║`);
  lines.push(`║  Domains: ${timeline.domains.join(', ').substring(0, 40).padEnd(40)} ║`);
  lines.push('╠════════════════════════════════════════════════════════════╣');
  
  const startTime = timeline.events[0]?.timestamp.getTime() || 0;
  
  timeline.events.forEach((event, index) => {
    const offset = event.timestamp.getTime() - startTime;
    const icon = index === 0 ? '►' : '├';
    const domain = event.domain.substring(0, 10).padEnd(10);
    const eventType = event.eventType.substring(0, 25).padEnd(25);
    
    lines.push(`║ ${icon} +${String(offset).padStart(5)}ms | ${domain} | ${eventType} ║`);
  });
  
  lines.push('╚════════════════════════════════════════════════════════════╝');
  lines.push('');
  
  return lines.join('\n');
}

// ============================================
// SPAN TRACKING
// ============================================

export class Span {
  constructor(context, operation) {
    this.context = context;
    this.operation = operation;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.status = 'running';
    this.tags = {};
  }

  setTag(key, value) {
    this.tags[key] = value;
    return this;
  }

  finish(status = 'success', error = null) {
    this.endedAt = Date.now();
    this.status = status;
    this.duration = this.endedAt - this.startedAt;

    const logData = {
      correlationId: this.context.correlationId,
      spanId: this.context.spanId,
      operation: this.operation,
      duration: this.duration,
      status,
      tags: this.tags
    };

    if (error) {
      logData.error = error.message;
      logData.stack = error.stack;
      logger.error(`[${this.context.domain}] Operation failed`, logData);
    } else {
      logger.info(`[${this.context.domain}] Operation completed`, logData);
    }

    return this;
  }
}

export function startSpan(context, operation) {
  return new Span(context, operation);
}

// ============================================
// EXPORTS
// ============================================

export default {
  getCorrelationId,
  createTracingContext,
  propagateContext,
  trackEvent,
  getEventTimeline,
  renderTimeline,
  startSpan
};

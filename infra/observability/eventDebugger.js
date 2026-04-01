// back/infra/observability/eventDebugger.js
/**
 * Event Debugger & Timeline Visualizer
 * 
 * Ferramenta de debugging visual para eventos.
 * Permite rastrear um correlationId ponta a ponta.
 * 
 * Features:
 * - Timeline visual ASCII
 * - Detecção de gaps no fluxo
 * - Análise de performance
 * - Exportação para análise
 */

import mongoose from 'mongoose';
import { logger } from '../logger.js';

// ============================================
// EVENT DEBUGGER
// ============================================

export class EventDebugger {
  constructor(eventStore) {
    this.eventStore = eventStore;
  }

  /**
   * Analisa fluxo completo de um correlationId
   */
  async debugCorrelationId(correlationId) {
    const events = await this.eventStore
      .find({ correlationId })
      .sort({ createdAt: 1 })
      .lean();

    if (events.length === 0) {
      return {
        correlationId,
        status: 'not_found',
        message: 'No events found for this correlationId'
      };
    }

    const analysis = {
      correlationId,
      status: 'found',
      summary: this.generateSummary(events),
      timeline: this.buildTimeline(events),
      gaps: this.detectGaps(events),
      performance: this.analyzePerformance(events),
      domains: this.analyzeDomains(events),
      visualization: this.renderVisualTimeline(events)
    };

    return analysis;
  }

  /**
   * Gera resumo do fluxo
   */
  generateSummary(events) {
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const duration = lastEvent.createdAt - firstEvent.createdAt;

    return {
      totalEvents: events.length,
      startTime: firstEvent.createdAt,
      endTime: lastEvent.createdAt,
      duration: `${duration}ms (${(duration / 1000).toFixed(2)}s)`,
      domains: [...new Set(events.map(e => this.extractDomain(e)))],
      eventTypes: [...new Set(events.map(e => e.eventType))],
      status: this.determineOverallStatus(events)
    };
  }

  /**
   * Constrói timeline detalhada
   */
  buildTimeline(events) {
    const startTime = events[0].createdAt.getTime();

    return events.map((event, index) => ({
      sequence: index + 1,
      timestamp: event.createdAt,
      offset: `${event.createdAt.getTime() - startTime}ms`,
      domain: this.extractDomain(event),
      eventType: event.eventType,
      status: event.status || 'unknown',
      payloadSummary: this.summarizePayload(event.payload),
      metadata: {
        worker: event.metadata?.worker,
        attempt: event.metadata?.attempt,
        error: event.metadata?.error
      }
    }));
  }

  /**
   * Detecta gaps no fluxo
   */
  detectGaps(events) {
    const gaps = [];
    const expectedFlows = this.getExpectedFlows();

    for (const flow of expectedFlows) {
      const gap = this.checkFlowGap(events, flow);
      if (gap) {
        gaps.push(gap);
      }
    }

    // Detecta gaps temporais (> 5s entre eventos)
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      const diff = curr.createdAt.getTime() - prev.createdAt.getTime();

      if (diff > 5000) {
        gaps.push({
          type: 'temporal_gap',
          between: `${prev.eventType} → ${curr.eventType}`,
          duration: `${diff}ms`,
          severity: diff > 30000 ? 'high' : diff > 10000 ? 'medium' : 'low'
        });
      }
    }

    return gaps;
  }

  /**
   * Analisa performance
   */
  analyzePerformance(events) {
    const domainTimings = {};
    const eventTypeTimings = {};

    // Agrupa por domínio
    for (const event of events) {
      const domain = this.extractDomain(event);
      if (!domainTimings[domain]) {
        domainTimings[domain] = { count: 0, events: [] };
      }
      domainTimings[domain].count++;
      domainTimings[domain].events.push(event.eventType);

      // Por tipo de evento
      if (!eventTypeTimings[event.eventType]) {
        eventTypeTimings[event.eventType] = 0;
      }
      eventTypeTimings[event.eventType]++;
    }

    return {
      domainBreakdown: domainTimings,
      eventTypeBreakdown: eventTypeTimings,
      bottlenecks: this.identifyBottlenecks(events)
    };
  }

  /**
   * Analisa domínios envolvidos
   */
  analyzeDomains(events) {
    const domains = {};

    for (const event of events) {
      const domain = this.extractDomain(event);
      if (!domains[domain]) {
        domains[domain] = {
          eventCount: 0,
          eventTypes: new Set(),
          firstEvent: null,
          lastEvent: null
        };
      }

      domains[domain].eventCount++;
      domains[domain].eventTypes.add(event.eventType);

      if (!domains[domain].firstEvent || event.createdAt < domains[domain].firstEvent) {
        domains[domain].firstEvent = event.createdAt;
      }
      if (!domains[domain].lastEvent || event.createdAt > domains[domain].lastEvent) {
        domains[domain].lastEvent = event.createdAt;
      }
    }

    // Converte Sets para arrays
    for (const domain of Object.keys(domains)) {
      domains[domain].eventTypes = [...domains[domain].eventTypes];
      domains[domain].duration = domains[domain].lastEvent - domains[domain].firstEvent;
    }

    return domains;
  }

  /**
   * Renderiza timeline visual ASCII
   */
  renderVisualTimeline(events) {
    const lines = [];
    const startTime = events[0].createdAt.getTime();
    const totalDuration = events[events.length - 1].createdAt.getTime() - startTime;

    lines.push('');
    lines.push('╔══════════════════════════════════════════════════════════════════════════════╗');
    lines.push('║                      EVENT FLOW VISUALIZATION                                ║');
    lines.push('╚══════════════════════════════════════════════════════════════════════════════╝');
    lines.push('');

    // Timeline horizontal
    const width = 60;
    
    events.forEach((event, index) => {
      const offset = event.createdAt.getTime() - startTime;
      const position = totalDuration > 0 
        ? Math.floor((offset / totalDuration) * width)
        : 0;

      const domain = this.extractDomain(event);
      const domainColor = this.getDomainColor(domain);
      const icon = this.getEventIcon(event.eventType);
      
      const bar = ' '.repeat(position) + icon;
      const label = `${domain.substring(0, 12).padEnd(12)} | ${event.eventType.substring(0, 25)}`;
      const time = `+${offset}ms`;

      lines.push(`${bar.padEnd(width + 5)} ${label} ${time}`);
    });

    lines.push('');
    lines.push('─'.repeat(width + 50));
    lines.push('');

    // Legenda de domínios
    lines.push('DOMAINS:');
    const domains = [...new Set(events.map(e => this.extractDomain(e)))];
    domains.forEach(domain => {
      const color = this.getDomainColor(domain);
      lines.push(`  ${color} ${domain}`);
    });

    lines.push('');

    return lines.join('\n');
  }

  /**
   * Gera diagrama de sequência Mermaid
   */
  generateMermaidDiagram(events) {
    const domains = [...new Set(events.map(e => this.extractDomain(e)))];
    const lines = ['sequenceDiagram'];

    // Participantes
    domains.forEach(domain => {
      lines.push(`    participant ${domain}`);
    });

    // Mensagens
    let prevDomain = null;
    for (const event of events) {
      const domain = this.extractDomain(event);
      
      if (prevDomain && prevDomain !== domain) {
        lines.push(`    ${prevDomain}->>${domain}: ${event.eventType}`);
      } else {
        lines.push(`    Note over ${domain}: ${event.eventType}`);
      }
      
      prevDomain = domain;
    }

    return lines.join('\n');
  }

  // ============================================
  // HELPERS
  // ============================================

  extractDomain(event) {
    // Extrai domínio do eventType ou metadata
    if (event.metadata?.domain) {
      return event.metadata.domain;
    }
    
    const prefixes = {
      'SESSION': 'Clinical',
      'APPOINTMENT': 'Clinical',
      'PATIENT': 'Clinical',
      'INSURANCE': 'Billing',
      'BILLING': 'Billing',
      'WHATSAPP': 'WhatsApp',
      'MESSAGE': 'WhatsApp',
      'NOTIFICATION': 'WhatsApp'
    };

    for (const [prefix, domain] of Object.entries(prefixes)) {
      if (event.eventType?.startsWith(prefix)) {
        return domain;
      }
    }

    return 'Unknown';
  }

  determineOverallStatus(events) {
    const hasError = events.some(e => 
      e.status === 'failed' || 
      e.status === 'error' ||
      e.metadata?.error
    );

    const hasDLQ = events.some(e => e.eventType === 'DLQ_MESSAGE_ADDED');

    if (hasDLQ) return 'failed_with_dlq';
    if (hasError) return 'failed';
    return 'success';
  }

  summarizePayload(payload) {
    if (!payload) return 'empty';
    
    const keys = Object.keys(payload);
    if (keys.length === 0) return 'empty';
    
    // Mostra campos importantes
    const importantFields = ['sessionId', 'patientId', 'appointmentId', 'phone', 'status'];
    const summary = {};
    
    for (const field of importantFields) {
      if (payload[field]) {
        summary[field] = payload[field];
      }
    }

    if (Object.keys(summary).length > 0) {
      return summary;
    }

    return { fields: keys.slice(0, 5) };
  }

  getExpectedFlows() {
    return [
      {
        name: 'Session Completion → Billing',
        events: ['SESSION_COMPLETED', 'INSURANCE_ITEM_CREATED'],
        required: true
      },
      {
        name: 'WhatsApp Message Flow',
        events: ['WHATSAPP_MESSAGE_RECEIVED', 'LEAD_STATE_CHECK_REQUESTED', 'ORCHESTRATOR_RUN_REQUESTED', 'NOTIFICATION_REQUESTED'],
        required: false
      },
      {
        name: 'Appointment Scheduling',
        events: ['APPOINTMENT_SCHEDULED', 'SESSION_SCHEDULED'],
        required: false
      }
    ];
  }

  checkFlowGap(events, flow) {
    const foundEvents = flow.events.filter(expectedType =>
      events.some(e => e.eventType === expectedType)
    );

    if (foundEvents.length > 0 && foundEvents.length < flow.events.length) {
      const missing = flow.events.filter(t => !foundEvents.includes(t));
      return {
        type: 'flow_incomplete',
        flowName: flow.name,
        found: foundEvents,
        missing,
        severity: flow.required ? 'high' : 'medium'
      };
    }

    return null;
  }

  identifyBottlenecks(events) {
    const bottlenecks = [];

    for (let i = 1; i < events.length; i++) {
      const diff = events[i].createdAt.getTime() - events[i - 1].createdAt.getTime();
      
      if (diff > 10000) { // > 10s
        bottlenecks.push({
          between: `${events[i - 1].eventType} → ${events[i].eventType}`,
          duration: `${diff}ms`,
          severity: diff > 30000 ? 'critical' : 'warning'
        });
      }
    }

    return bottlenecks;
  }

  getDomainColor(domain) {
    const colors = {
      'Clinical': '🟦',
      'Billing': '🟩',
      'WhatsApp': '🟨',
      'Unknown': '⬜'
    };
    return colors[domain] || '⬜';
  }

  getEventIcon(eventType) {
    const icons = {
      'SESSION_COMPLETED': '✓',
      'SESSION_CANCELLED': '✗',
      'APPOINTMENT_SCHEDULED': '📅',
      'PATIENT_REGISTERED': '👤',
      'INSURANCE_ITEM_CREATED': '💰',
      'WHATSAPP_MESSAGE_RECEIVED': '💬',
      'NOTIFICATION_REQUESTED': '📤',
      'DLQ_MESSAGE_ADDED': '⚠️'
    };
    return icons[eventType] || '●';
  }

  // ============================================
  // CLI DEBUG
  // ============================================

  /**
   * Debug interativo via CLI
   */
  async debugInteractive(correlationId) {
    const analysis = await this.debugCorrelationId(correlationId);

    console.log('\n' + '='.repeat(80));
    console.log('EVENT DEBUGGER');
    console.log('='.repeat(80));

    if (analysis.status === 'not_found') {
      console.log('\n❌ ' + analysis.message);
      return;
    }

    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`   CorrelationId: ${analysis.correlationId}`);
    console.log(`   Status: ${analysis.summary.status}`);
    console.log(`   Total Events: ${analysis.summary.totalEvents}`);
    console.log(`   Duration: ${analysis.summary.duration}`);
    console.log(`   Domains: ${analysis.summary.domains.join(', ')}`);

    // Timeline
    console.log('\n📜 TIMELINE:');
    console.log(analysis.visualization);

    // Gaps
    if (analysis.gaps.length > 0) {
      console.log('\n⚠️  GAPS DETECTED:');
      analysis.gaps.forEach(gap => {
        const icon = gap.severity === 'high' ? '🔴' : gap.severity === 'medium' ? '🟡' : '🟢';
        console.log(`   ${icon} ${gap.type}: ${gap.between || gap.flowName}`);
        if (gap.duration) console.log(`      Duration: ${gap.duration}`);
        if (gap.missing) console.log(`      Missing: ${gap.missing.join(', ')}`);
      });
    }

    // Performance
    console.log('\n⚡ PERFORMANCE:');
    if (analysis.performance.bottlenecks.length > 0) {
      console.log('   Bottlenecks:');
      analysis.performance.bottlenecks.forEach(b => {
        const icon = b.severity === 'critical' ? '🔴' : '🟡';
        console.log(`   ${icon} ${b.between}: ${b.duration}`);
      });
    } else {
      console.log('   ✅ No bottlenecks detected');
    }

    // Domain breakdown
    console.log('\n🌐 DOMAINS:');
    Object.entries(analysis.domains).forEach(([domain, info]) => {
      console.log(`   ${domain}: ${info.eventCount} events (${info.duration}ms)`);
    });

    console.log('\n' + '='.repeat(80));

    return analysis;
  }
}

// ============================================
// EXPORTS
// ============================================

export default EventDebugger;

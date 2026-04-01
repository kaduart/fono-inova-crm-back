// tests/framework/EventTracer.js
// Observabilidade: rastreia timing de eventos no fluxo

import { setTimeout } from 'timers/promises';

export default class EventTracer {
  constructor() {
    this.traces = new Map();
    this.spans = [];
  }
  
  /**
   * Inicia um trace para um correlationId
   */
  startTrace(correlationId, metadata = {}) {
    this.traces.set(correlationId, {
      id: correlationId,
      startTime: Date.now(),
      spans: [],
      metadata
    });
    return this;
  }
  
  /**
   * Adiciona um span ao trace
   */
  addSpan(correlationId, name, data = {}) {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      console.warn(`Trace não encontrado: ${correlationId}`);
      return this;
    }
    
    const span = {
      name,
      timestamp: Date.now(),
      relativeTime: Date.now() - trace.startTime,
      data
    };
    
    trace.spans.push(span);
    this.spans.push({ ...span, correlationId });
    
    return this;
  }
  
  /**
   * Finaliza o trace
   */
  endTrace(correlationId, result = {}) {
    const trace = this.traces.get(correlationId);
    if (!trace) return null;
    
    trace.endTime = Date.now();
    trace.duration = trace.endTime - trace.startTime;
    trace.result = result;
    
    return trace;
  }
  
  /**
   * Coleta eventos do outbox para um correlationId
   */
  async collectEvents(mongoose, correlationId, timeout = 10000) {
    const start = Date.now();
    const events = [];
    
    while (Date.now() - start < timeout) {
      const found = await mongoose.connection.db
        .collection('outbox')
        .find({ correlationId })
        .sort({ createdAt: 1 })
        .toArray();
      
      for (const event of found) {
        if (!events.find(e => e._id.equals(event._id))) {
          this.addSpan(correlationId, `EVENT:${event.type}`, {
            eventId: event._id,
            status: event.status,
            payload: event.payload
          });
          events.push(event);
        }
      }
      
      // Verifica se temos todos os eventos esperados
      const hasComplete = events.some(e => e.type === 'APPOINTMENT_COMPLETED');
      const hasInvoice = events.some(e => e.type === 'INVOICE_CREATED');
      
      if (hasComplete && hasInvoice) {
        break;
      }
      
      await setTimeout(200);
    }
    
    return events;
  }
  
  /**
   * Analisa gargalos no trace
   */
  analyzeBottlenecks(correlationId) {
    const trace = this.traces.get(correlationId);
    if (!trace) return null;
    
    const analysis = {
      totalDuration: trace.duration,
      spans: [],
      gaps: [],
      recommendations: []
    };
    
    // Calcula gaps entre spans
    for (let i = 1; i < trace.spans.length; i++) {
      const prev = trace.spans[i - 1];
      const curr = trace.spans[i];
      const gap = curr.relativeTime - prev.relativeTime;
      
      if (gap > 500) { // Gaps maiores que 500ms
        analysis.gaps.push({
          from: prev.name,
          to: curr.name,
          duration: gap
        });
      }
    }
    
    // Recomendações
    if (analysis.gaps.some(g => g.duration > 2000)) {
      analysis.recommendations.push('Considerar otimização de workers ou filas');
    }
    
    if (trace.duration > 10000) {
      analysis.recommendations.push('Fluxo muito lento - revisar timeout de 10s');
    }
    
    return analysis;
  }
  
  /**
   * Gera relatório em formato legível
   */
  generateReport(correlationId = null) {
    if (correlationId) {
      return this.generateSingleReport(correlationId);
    }
    
    // Relatório agregado
    let report = '\n' + '='.repeat(70) + '\n';
    report += '  📊 EVENT TRACER REPORT\n';
    report += '='.repeat(70) + '\n';
    
    const traces = Array.from(this.traces.values());
    
    if (traces.length === 0) {
      report += '  Nenhum trace registrado\n';
      return report;
    }
    
    // Estatísticas
    const durations = traces.map(t => t.duration).filter(Boolean);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);
    
    report += `\n  📈 Estatísticas (${traces.length} traces):\n`;
    report += `     Média: ${avgDuration.toFixed(0)}ms\n`;
    report += `     Mín: ${minDuration}ms | Máx: ${maxDuration}ms\n`;
    
    // Gargalos comuns
    const allGaps = traces.flatMap(t => this.analyzeBottlenecks(t.id)?.gaps || []);
    if (allGaps.length > 0) {
      report += `\n  🐌 Gaps mais comuns:\n`;
      const gapCounts = {};
      allGaps.forEach(g => {
        const key = `${g.from} → ${g.to}`;
        gapCounts[key] = (gapCounts[key] || 0) + 1;
      });
      
      Object.entries(gapCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([key, count]) => {
          report += `     ${key}: ${count}x\n`;
        });
    }
    
    report += '\n' + '='.repeat(70) + '\n';
    return report;
  }
  
  generateSingleReport(correlationId) {
    const trace = this.traces.get(correlationId);
    if (!trace) return `Trace não encontrado: ${correlationId}`;
    
    let report = '\n' + '='.repeat(70) + '\n';
    report += `  📊 TRACE: ${correlationId}\n`;
    report += '='.repeat(70) + '\n';
    
    if (trace.metadata && Object.keys(trace.metadata).length > 0) {
      report += `  Metadata: ${JSON.stringify(trace.metadata)}\n\n`;
    }
    
    // Timeline
    report += '  ⏱️  Timeline:\n';
    trace.spans.forEach((span, idx) => {
      const prevTime = idx > 0 ? trace.spans[idx - 1].relativeTime : 0;
      const diff = span.relativeTime - prevTime;
      const diffStr = idx > 0 ? `(+${diff}ms)` : '(start)';
      report += `     ${span.relativeTime.toString().padStart(5)}ms ${diffStr.padStart(8)}  ${span.name}\n`;
    });
    
    if (trace.duration) {
      report += `     ${trace.duration.toString().padStart(5)}ms (total)\n`;
    }
    
    // Análise
    const analysis = this.analyzeBottlenecks(correlationId);
    if (analysis?.gaps.length > 0) {
      report += '\n  🐌 Gaps identificados:\n';
      analysis.gaps.forEach(g => {
        report += `     ${g.from} → ${g.to}: ${g.duration}ms\n`;
      });
    }
    
    if (analysis?.recommendations.length > 0) {
      report += '\n  💡 Recomendações:\n';
      analysis.recommendations.forEach(r => {
        report += `     • ${r}\n`;
      });
    }
    
    report += '\n' + '='.repeat(70) + '\n';
    return report;
  }
  
  /**
   * Limpa todos os traces
   */
  clear() {
    this.traces.clear();
    this.spans = [];
  }
  
  /**
   * Exporta traces para JSON (para análise externa)
   */
  exportJSON() {
    return JSON.stringify({
      traces: Array.from(this.traces.values()),
      exportTime: new Date().toISOString()
    }, null, 2);
  }
}

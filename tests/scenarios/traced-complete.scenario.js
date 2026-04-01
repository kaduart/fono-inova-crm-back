// tests/scenarios/traced-complete.scenario.js
// Cenário com rastreamento detalhado de eventos

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';
import EventTracer from '../framework/EventTracer.js';


export default {
  name: 'Traced Complete (observability)',
  
  async setup(ctx) {
    const { fixtures } = ctx;
    const tracer = new EventTracer();
    
    const doctor = await fixtures.doctor();
    const patient = await fixtures.patient();
    const pkg = await fixtures.package(
      { patient, doctor },
      { paymentType: 'per-session' }
    );
    const appointment = await fixtures.appointment(
      { patient, doctor, package: pkg },
      { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
    );
    
    return { doctor, patient, pkg, appointment, tracer };
  },
  
  async execute({ data }) {
    const { appointment, tracer, patient } = data;
    const correlationId = `trace-${Date.now()}`;
    
    console.log(`\n  🔍 Iniciando trace: ${correlationId}`);
    tracer.startTrace(correlationId, {
      appointmentId: appointment._id.toString(),
      patientId: patient._id.toString()
    });
    
    tracer.addSpan(correlationId, 'SETUP_COMPLETE');
    
    // Chamada API
    tracer.addSpan(correlationId, 'API_CALL_START');
    const startTime = Date.now();
    
    const response = await api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { 
        timeout: 10000,
        headers: { 'X-Correlation-ID': correlationId }
      }
    );
    
    const apiDuration = Date.now() - startTime;
    tracer.addSpan(correlationId, 'API_CALL_END', {
      duration: apiDuration,
      status: response.status
    });
    
    console.log(`  ⏱️  API response: ${apiDuration}ms`);
    
    return { correlationId, apiDuration };
  },
  
  async assert({ data, runner }) {
    const { appointment, patient, tracer, result } = data;
    
    // Aguarda processamento
    tracer.addSpan(result.correlationId, 'WAITING_WORKERS');
    await runner.sleep(3000);
    
    // Coleta eventos do outbox
    tracer.addSpan(result.correlationId, 'COLLECTING_EVENTS');
    await tracer.collectEvents(
      runner.mongoose || mongoose, 
      result.correlationId, 
      5000
    );
    
    tracer.addSpan(result.correlationId, 'ASSERT_START');
    
    // Valida appointment
    const apt = await mongoose.connection.db
      .collection('appointments')
      .findOne({ _id: appointment._id });
    
    tracer.addSpan(result.correlationId, 'DB_CHECK_APPOINTMENT', {
      status: apt.clinicalStatus
    });
    
    // Valida invoice
    const invoice = await mongoose.connection.db
      .collection('invoices')
      .findOne({ patient: patient._id });
    
    tracer.addSpan(result.correlationId, 'DB_CHECK_INVOICE', {
      found: !!invoice,
      invoiceId: invoice?._id
    });
    
    tracer.endTrace(result.correlationId, {
      success: apt.clinicalStatus === 'completed' && !!invoice
    });
    
    // Gera relatório
    console.log(tracer.generateReport(result.correlationId));
    
    // Validações
    if (apt.clinicalStatus !== 'completed') {
      throw new Error('Appointment não completado');
    }
    
    if (!invoice) {
      throw new Error('Invoice não criada');
    }
  },
  
  async cleanup({ data, fixtures }) {
    await fixtures.cleanup();
  }
};

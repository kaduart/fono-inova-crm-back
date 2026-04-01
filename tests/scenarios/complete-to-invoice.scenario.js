// tests/scenarios/complete-to-invoice.scenario.js
// Cenário: Complete Session → Invoice (com validação de eventos e idempotência)

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';
import { waitFor, waitForDocument } from '../helpers/waitFor.js';

export default {
  name: 'Complete Session → Invoice (Particular Per-Session)',
  
  // 🎭 SETUP: Cria dados de teste
  async setup(ctx) {
    const { fixtures } = ctx;
    
    // 1. Criar dados base
    const doctor = await fixtures.doctor();
    const patient = await fixtures.patient();
    const pkg = await fixtures.package(
      { patient, doctor },
      { paymentType: 'per-session', sessionValue: 200 }
    );
    const appointment = await fixtures.appointment(
      { patient, doctor, package: pkg },
      { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
    );
    const session = await fixtures.session(
      { patient, doctor, package: pkg, appointment },
      { status: 'scheduled' }
    );
    
    // 2. GARANTIR consistência - aguardar até estar disponível para leitura
    const db = mongoose.connection.db;
    
    await waitForDocument(db, 'packages', { _id: pkg._id }, {
      timeout: 5000,
      debugLabel: 'package-created'
    });
    
    await waitForDocument(db, 'appointments', { _id: appointment._id }, {
      timeout: 5000,
      debugLabel: 'appointment-created'
    });
    
    console.log('✅ Dados consistentes no banco:', {
      doctor: doctor._id.toString(),
      patient: patient._id.toString(),
      package: pkg._id.toString(),
      appointment: appointment._id.toString()
    });
    
    return { 
      doctor, 
      patient, 
      pkg, 
      appointment, 
      session 
    };
  },
  
  // 🎬 EXECUTE: Chama API v2 para completar
  async execute({ data }) {
    const { appointment } = data;
    
    // Chama endpoint de complete com auth automática
    const response = await api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 5000 }
    );
    
    return response.data;
  },
  
  // ✅ ASSERT: Validações completas
  async assert({ data, runner }) {
    const { patient, appointment, session } = data;
    const db = mongoose.connection.db;
    
    // 1. Aguarda processamento do complete (appointment.status = completed)
    const completedAppointment = await waitFor(async () => {
      const apt = await db.collection('appointments').findOne({ _id: appointment._id });
      return apt?.clinicalStatus === 'completed' ? apt : null;
    }, {
      timeout: 15000,
      interval: 500,
      debugLabel: 'appointment-completed'
    });
    
    console.log('✅ Appointment completado:', completedAppointment._id.toString());
    
    // 2. Valida EVENTO foi emitido (outbox)
    await runner.assertEventEmitted('APPOINTMENT_COMPLETED', {
      'payload.appointmentId': appointment._id.toString()
    });
    
    // 3. Aguarda invoice ser criada (processamento assíncrono)
    const invoice = await waitFor(async () => {
      return await db.collection('invoices').findOne({ 
        patient: patient._id,
        appointment: appointment._id
      });
    }, {
      timeout: 15000,
      interval: 500,
      debugLabel: 'invoice-created'
    });
    
    if (!invoice) {
      throw new Error('Invoice não foi criada após processamento');
    }
    
    console.log('✅ Invoice criada:', invoice._id.toString(), 'Valor:', invoice.total);
    
    // 4. Valida banco - Appointment
    await runner.assertDatabase('appointments', 
      { _id: appointment._id },
      {
        'clinicalStatus': 'completed',
        'operationalStatus': 'confirmed'
      }
    );
    
    // 5. Valida invoice - valores corretos
    if (invoice.total !== 200) {
      throw new Error(`Valor da invoice incorreto: esperado 200, obtido ${invoice.total}`);
    }
    
    console.log('✅ Fluxo completo validado: Complete → Payment → Invoice');
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};

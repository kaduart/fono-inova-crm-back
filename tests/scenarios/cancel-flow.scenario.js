// tests/scenarios/cancel-flow.scenario.js
// Cenário CRÍTICO: Cancelamento completo (estorna pagamento, restaura pacote, cancela invoice)

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';


export default {
  name: 'Cancel Flow - Estorna tudo corretamente',
  
  async setup(ctx) {
    const { fixtures } = ctx;
    
    const doctor = await fixtures.doctor();
    const patient = await fixtures.patient();
    const pkg = await fixtures.package(
      { patient, doctor },
      { 
        paymentType: 'per-session',
        sessionValue: 200,
        sessionsDone: 1,  // Já consumiu 1
        sessionsAvailable: 9
      }
    );
    const appointment = await fixtures.appointment(
      { patient, doctor, package: pkg },
      { 
        clinicalStatus: 'completed',  // Já foi completado
        operationalStatus: 'confirmed',
        paymentOrigin: 'auto_per_session'
      }
    );
    
    // Cria payment e invoice manualmente (simula estado pós-complete)
    const Payment = mongoose.model('Payment');
    const Invoice = mongoose.model('Invoice');
    
    const payment = await Payment.create({
      patient: patient._id,
      doctor: doctor._id,
      appointment: appointment._id,
      amount: 200,
      status: 'paid',
      paymentMethod: 'pix',  // ← Obrigatório pelo schema
      paymentOrigin: 'auto_per_session',
      serviceDate: new Date()
    });
    
    const now = new Date();
    const invoice = await Invoice.create({
      invoiceNumber: `FAT-${Date.now()}`,
      type: 'patient',
      origin: 'session',
      patient: patient._id,
      doctor: doctor._id,
      startDate: now,  // ← Obrigatório
      endDate: now,    // ← Obrigatório
      dueDate: now,    // ← Obrigatório
      items: [{
        description: 'Sessão teste',
        quantity: 1,
        unitValue: 200,
        totalValue: 200,
        appointment: appointment._id
      }],
      subtotal: 200,
      total: 200,
      paidAmount: 200,
      balance: 0,
      status: 'paid',
      payments: [payment._id]
    });
    
    // Vincula ao appointment
    await mongoose.connection.db.collection('appointments').updateOne(
      { _id: appointment._id },
      { 
        $set: { 
          payment: payment._id,
          invoice: invoice._id
        }
      }
    );
    
    return { doctor, patient, pkg, appointment, payment, invoice };
  },
  
  async execute({ data }) {
    const { appointment } = data;
    
    // Chama CANCEL
    const response = await api.patch(
      `/api/v2/appointments/${appointment._id}/cancel`,
      {
        reason: 'Teste de cancelamento',
        confirmedAbsence: false
      },
      { timeout: 5000 }
    );
    
    return response.data;
  },
  
  async assert({ data, runner }) {
    const { patient, pkg, appointment, payment, invoice } = data;
    
    // Aguarda processamento
    await runner.sleep(2000);
    
    // 1. Appointment está canceled
    await runner.assertDatabase('appointments',
      { _id: appointment._id },
      {
        'operationalStatus': 'canceled',
        'clinicalStatus': 'completed'  // Não muda
      }
    );
    
    // 2. Package restaurou sessão
    const packageUpdated = await mongoose.connection.db
      .collection('packages')
      .findOne({ _id: pkg._id });
    
    if (packageUpdated.sessionsDone !== 0) {
      throw new Error(`SessionsDone não restaurou: ${packageUpdated.sessionsDone}`);
    }
    
    if (packageUpdated.sessionsAvailable !== 10) {
      throw new Error(`SessionsAvailable não restaurou: ${packageUpdated.sessionsAvailable}`);
    }
    
    // 3. Payment foi estornado (ou marcado como canceled)
    const paymentUpdated = await mongoose.connection.db
      .collection('payments')
      .findOne({ _id: payment._id });
    
    // Se o sistema estorna, deve ter criado um refund ou marcado como canceled
    if (paymentUpdated.status !== 'canceled' && paymentUpdated.status !== 'refunded') {
      throw new Error(`Payment não foi estornado: ${paymentUpdated.status}`);
    }
    
    // 4. Invoice foi cancelada
    const invoiceUpdated = await mongoose.connection.db
      .collection('invoices')
      .findOne({ _id: invoice._id });
    
    if (invoiceUpdated.status !== 'canceled') {
      throw new Error(`Invoice não foi cancelada: ${invoiceUpdated.status}`);
    }
    
    // 5. Eventos emitidos
    await runner.assertEventEmitted('APPOINTMENT_CANCELED', {
      'payload.appointmentId': appointment._id.toString()
    });
    
    // 6. Idempotência - não criou duplicatas
    await runner.assertIdempotency('payments', { appointment: appointment._id }, 1);
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};

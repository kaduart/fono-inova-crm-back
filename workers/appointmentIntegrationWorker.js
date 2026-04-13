// workers/appointmentIntegrationWorker.js
/**
 * 🎯 Appointment Integration Worker
 * 
 * Responsabilidade ÚNICA: Side effects de atualização de Appointment
 * - Payment updates/creates
 * - Package updates
 * - Patient updates (médico)
 * 
 * 🏗️ Arquitetura: Consolida todos os side effects em um único worker
 */

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';

// Lazy load de models
const getModels = async () => {
  const [Payment, Package, Patient] = await Promise.all([
    import('../models/Payment.js').then(m => m.default),
    import('../models/Package.js').then(m => m.default),
    import('../models/Patient.js').then(m => m.default)
  ]);
  return { Payment, Package, Patient };
};

export function startAppointmentIntegrationWorker() {
  console.log('[AppointmentIntegration] 🚀 Worker iniciado');

  const worker = new Worker('appointment-integration', async (job) => {
    const { eventId, correlationId, payload } = job.data;
    const { 
      appointmentId,
      sideEffects,
      updatedBy,
      changes = []
    } = payload;

    const log = createContextLogger(correlationId, 'appointmentIntegration');
    
    // 🚀 LOG DETALHADO PARA DEBUG
    console.log(`[AppointmentIntegration] Recebido evento:`, {
      appointmentId,
      hasSideEffects: !!sideEffects,
      patient: {
        shouldUpdate: sideEffects?.patient?.shouldUpdate,
        patientId: sideEffects?.patient?.patientId,
        newDoctorId: sideEffects?.patient?.newDoctorId
      }
    });
    
    log.info('start', 'Processando side effects do appointment', {
      appointmentId,
      changes,
      hasPayment: sideEffects?.payment?.shouldUpdate,
      hasPackage: sideEffects?.package?.shouldUpdate,
      hasPatient: sideEffects?.patient?.shouldUpdate
    });

    const results = {
      payment: null,
      package: null,
      patient: null
    };

    try {
      const { Payment, Package, Patient } = await getModels();

      // ============================================================
      // 1. PAYMENT SIDE EFFECT
      // ============================================================
      if (sideEffects?.payment?.shouldUpdate) {
        const { paymentId, isNewPayment, updateData } = sideEffects.payment;
        
        try {
          if (isNewPayment) {
            // Criar novo pagamento
            const newPayment = new Payment({
              patient: sideEffects.patient?.patientId,
              doctor: updateData.doctor,
              appointment: appointmentId,
              amount: updateData.amount || 0,
              paymentMethod: updateData.paymentMethod || 'dinheiro',
              serviceDate: updateData.serviceDate,
              serviceType: updateData.serviceType,
              billingType: updateData.billingType || 'particular',
              insuranceProvider: updateData.billingType === 'convenio' ? updateData.insuranceProvider : null,
              insuranceValue: updateData.billingType === 'convenio' ? updateData.insuranceValue : 0,
              authorizationCode: updateData.billingType === 'convenio' ? updateData.authorizationCode : null,
              status: updateData.billingType === 'convenio' ? 'pending' : 'paid',
              kind: 'manual',
              notes: `Criado via integration worker - ${new Date().toLocaleString('pt-BR')}`
            });
            
            await newPayment.save();
            results.payment = { action: 'created', id: newPayment._id.toString() };
            log.info('payment_created', 'Novo pagamento criado', { paymentId: newPayment._id });
            
          } else if (paymentId) {
            // Atualizar pagamento existente
            const existingPayment = await Payment.findById(paymentId).lean();
            
            if (!existingPayment) {
              log.warn('payment_not_found', 'Pagamento não encontrado', { paymentId });
              results.payment = { action: 'not_found', id: paymentId };
            } else if (existingPayment.status === 'paid') {
              // Só campos não-financeiros
              await Payment.findByIdAndUpdate(paymentId, {
                $set: { 
                  doctor: updateData.doctor, 
                  serviceDate: updateData.serviceDate, 
                  serviceType: updateData.serviceType,
                  updatedAt: new Date()
                }
              });
              results.payment = { action: 'updated_non_financial', id: paymentId };
              log.info('payment_updated_non_financial', 'Payment pago: campos não-financeiros', { paymentId });
            } else {
              // Atualiza tudo
              await Payment.findByIdAndUpdate(paymentId, {
                $set: { 
                  doctor: updateData.doctor,
                  amount: updateData.amount,
                  paymentMethod: updateData.paymentMethod,
                  serviceDate: updateData.serviceDate,
                  serviceType: updateData.serviceType,
                  billingType: updateData.billingType,
                  insuranceProvider: updateData.insuranceProvider,
                  insuranceValue: updateData.insuranceValue,
                  authorizationCode: updateData.authorizationCode,
                  updatedAt: new Date()
                }
              });
              results.payment = { action: 'updated', id: paymentId };
              log.info('payment_updated', 'Payment atualizado', { paymentId });
            }
          }
        } catch (err) {
          log.error('payment_error', 'Erro no side effect de payment', { error: err.message, stack: err.stack });
          results.payment = { action: 'error', error: err.message };
          // Não falha o job - continua com outros side effects
        }
      }

      // ============================================================
      // 2. PACKAGE SIDE EFFECT
      // ============================================================
      if (sideEffects?.package?.shouldUpdate) {
        const { packageId, updateData } = sideEffects.package;
        
        try {
          await Package.findByIdAndUpdate(packageId, {
            $set: { 
              doctor: updateData.doctor, 
              sessionValue: updateData.sessionValue, 
              updatedAt: new Date() 
            }
          });
          results.package = { action: 'updated', id: packageId, phase: 'FASE_2' };
          log.info('package_updated', '🚀 FASE 2: Pacote atualizado via side effect', { packageId });
        } catch (err) {
          log.error('package_error', 'Erro no side effect de package', { error: err.message });
          results.package = { action: 'error', error: err.message };
        }
      }

      // ============================================================
      // 3. PATIENT SIDE EFFECT (médico alterado)
      // ============================================================
      if (sideEffects?.patient?.shouldUpdate) {
        const { patientId, newDoctorId } = sideEffects.patient;
        
        try {
          await Patient.findByIdAndUpdate(patientId, {
            $set: { 
              doctor: newDoctorId, 
              updatedAt: new Date() 
            }
          });
          results.patient = { action: 'updated', id: patientId, newDoctorId };
          log.info('patient_updated', 'Paciente atualizado (médico alterado)', { patientId, newDoctorId });
        } catch (err) {
          log.error('patient_error', 'Erro no side effect de patient', { error: err.message });
          results.patient = { action: 'error', error: err.message };
        }
      }

      log.info('completed', 'Side effects processados', { 
        appointmentId,
        results,
        hasErrors: Object.values(results).some(r => r?.action === 'error')
      });

      return {
        status: 'completed',
        appointmentId,
        results,
        processedAt: new Date().toISOString()
      };

    } catch (error) {
      log.error('fatal_error', 'Erro fatal no worker', { error: error.message, stack: error.stack });
      
      await moveToDLQ('appointment-integration', job, error);
      
      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 5,
    limiter: {
      max: 50,
      duration: 1000
    }
  });

  worker.on('completed', (job, result) => {
    console.log(`[AppointmentIntegration] ✅ Job ${job.id}: ${result.status}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[AppointmentIntegration] ❌ Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

export default { startAppointmentIntegrationWorker };

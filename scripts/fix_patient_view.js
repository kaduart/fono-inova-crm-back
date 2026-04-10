/**
 * Script para verificar e corrigir paciente na view
 * Uso: node scripts/fix_patient_view.js
 */

const mongoose = require('mongoose');

async function fixPatientView() {
  try {
    // Conectar ao MongoDB
    await mongoose.connect('mongodb://localhost:27017/fono-inova-crm');
    const db = mongoose.connection.db;
    
    console.log('🔍 Buscando paciente: Luiz Henrique de Oliveira Ferreira...\n');
    
    // 1. Buscar na collection patients
    const patient = await db.collection('patients').findOne({
      fullName: { $regex: 'Luiz Henrique', $options: 'i' }
    });
    
    if (!patient) {
      console.log('❌ Paciente NÃO ENCONTRADO na collection patients');
      return;
    }
    
    console.log('✅ Paciente ENCONTRADO na collection patients:');
    console.log('  _id:', patient._id.toString());
    console.log('  Nome:', patient.fullName);
    console.log('  Telefone:', patient.phone);
    console.log('  Email:', patient.email);
    console.log('  Criado em:', patient.createdAt);
    console.log('');
    
    // 2. Verificar se existe na patients_view
    const existingView = await db.collection('patients_view').findOne({
      patientId: patient._id
    });
    
    if (existingView) {
      console.log('✅ Paciente JÁ EXISTE na patients_view');
      console.log('  View _id:', existingView._id.toString());
      return;
    }
    
    console.log('❌ Paciente NÃO existe na patients_view');
    console.log('📝 Criando view manualmente...\n');
    
    // 3. Criar a view manualmente
    const PatientsView = require('../models/PatientsView');
    
    const viewData = {
      patientId: patient._id,
      fullName: patient.fullName,
      normalizedName: patient.fullName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      dateOfBirth: patient.dateOfBirth,
      phone: patient.phone,
      phoneDigits: patient.phone ? patient.phone.replace(/\D/g, '') : null,
      email: patient.email,
      cpf: patient.cpf,
      cpfDigits: patient.cpf ? patient.cpf.replace(/\D/g, '') : null,
      doctorId: patient.doctor,
      mainComplaint: patient.mainComplaint,
      stats: {
        totalAppointments: 0,
        totalCompleted: 0,
        totalCanceled: 0,
        totalNoShow: 0,
        totalSessions: 0,
        totalPackages: 0,
        totalRevenue: 0,
        totalPending: 0
      },
      snapshot: {
        isStale: false,
        version: 1,
        lastSyncedAt: new Date()
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const newView = await PatientsView.create(viewData);
    
    console.log('✅ View criada com sucesso!');
    console.log('  View _id:', newView._id.toString());
    console.log('  PatientId:', newView.patientId.toString());
    console.log('');
    console.log('🎉 O paciente agora deve aparecer na lista!');
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
  }
}

// Executar
fixPatientView();

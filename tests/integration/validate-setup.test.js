/**
 * ✅ Teste de Validação do Setup
 * 
 * Este teste verifica se o ambiente de testes está configurado corretamente.
 * Execute primeiro para garantir que tudo está funcionando.
 */

import { describe, it, expect } from 'vitest';

describe('🔧 Validação do Ambiente de Testes', () => {
  it('deve ter variáveis de ambiente configuradas', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.AGENDA_EXPORT_TOKEN).toBeDefined();
    expect(process.env.JWT_SECRET).toBeDefined();
  });
  
  it('deve ter token de serviço definido', () => {
    const token = process.env.AGENDA_EXPORT_TOKEN;
    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(10);
    console.log('✅ Token de serviço:', token.substring(0, 20) + '...');
  });
  
  it('deve conseguir importar models', async () => {
    const { default: Appointment } = await import('../../models/Appointment.js');
    const { default: Patient } = await import('../../models/Patient.js');
    const { default: Doctor } = await import('../../models/Doctor.js');
    
    expect(Appointment).toBeDefined();
    expect(Patient).toBeDefined();
    expect(Doctor).toBeDefined();
  });
  
  it('deve conseguir importar middlewares', async () => {
    const { agendaAuth } = await import('../../middleware/agendaAuth.js');
    const { flexibleAuth } = await import('../../middleware/amandaAuth.js');
    
    expect(typeof agendaAuth).toBe('function');
    expect(typeof flexibleAuth).toBe('function');
  });
  
  it('deve conseguir importar utils', async () => {
    const { mapAppointmentToEvent } = await import('../../utils/appointmentMapper.js');
    expect(typeof mapAppointmentToEvent).toBe('function');
  });
});

describe('🔌 Conexão com MongoDB', () => {
  it('deve estar conectado ao MongoDB', async () => {
    const mongoose = await import('mongoose');
    expect(mongoose.default.connection.readyState).toBe(1); // 1 = connected
  });
  
  it('deve conseguir criar e ler documento', async () => {
    const { default: Doctor } = await import('../../models/Doctor.js');
    
    const doc = await Doctor.create({
      fullName: 'Dra. Teste Setup',
      email: 'setup@teste.com',
      specialty: 'fonoaudiologia',
      active: true
    });
    
    expect(doc._id).toBeDefined();
    expect(doc.fullName).toBe('Dra. Teste Setup');
    
    // Limpar
    await Doctor.findByIdAndDelete(doc._id);
  });
});

// Se este teste passar, o ambiente está pronto para os testes de integração

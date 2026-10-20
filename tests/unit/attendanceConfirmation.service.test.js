import { describe, expect, it } from 'vitest';
import { classifyAttendanceConfirmationResponse } from '../../services/appointment/attendanceConfirmation.service.js';
import Appointment from '../../models/Appointment.js';

describe('classifyAttendanceConfirmationResponse', () => {
  it.each([
    ['1', 'confirmed'],
    ['sim', 'confirmed'],
    ['Confirmo a presença', 'confirmed'],
    ['2', 'change_requested'],
    ['remarcar', 'change_requested'],
    ['cancelar', 'change_requested'],
  ])('classifica %s como %s', (text, expected) => {
    expect(classifyAttendanceConfirmationResponse(text)).toBe(expected);
  });

  it('ignora mensagens ambíguas', () => {
    expect(classifyAttendanceConfirmationResponse('qual é o endereço?')).toBeNull();
    expect(classifyAttendanceConfirmationResponse('ok, vou ver se consigo')).toBeNull();
  });

  it('cria todo novo agendamento com confirmação pendente por padrão', () => {
    const appointment = new Appointment({
      date: '2026-10-21',
      time: '09:00',
      specialty: 'fonoaudiologia',
    });

    expect(appointment.attendanceConfirmation.status).toBe('pending');
    expect(appointment.attendanceConfirmation.channel).toBe('whatsapp');
  });
});

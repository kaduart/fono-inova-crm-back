// tests/framework/Fixtures.js
// Dados fake reutilizáveis para testes

import PatientModule from '../../models/Patient.js';
import DoctorModule from '../../models/Doctor.js';
import PackageModule from '../../models/Package.js';
import AppointmentModule from '../../models/Appointment.js';
import SessionModule from '../../models/Session.js';

// Handle ES module default exports
const Patient = PatientModule.default || PatientModule;
const Doctor = DoctorModule.default || DoctorModule;
const Package = PackageModule.default || PackageModule;
const Appointment = AppointmentModule.default || AppointmentModule;
const Session = SessionModule.default || SessionModule;

export class Fixtures {
  constructor() {
    this.created = [];
  }

  async patient(overrides = {}) {
    const patient = await Patient.create({
      fullName: `Paciente Teste ${Date.now()}`,
      dateOfBirth: new Date('1990-01-01'),
      phone: '11999999999',
      email: `teste${Date.now()}@test.com`,
      ...overrides
    });
    this.created.push({ model: Patient, id: patient._id });
    return patient;
  }

  async doctor(overrides = {}) {
    const doctor = await Doctor.create({
      fullName: `Doutor Teste ${Date.now()}`,
      email: `doctor${Date.now()}@test.com`,
      specialty: 'psicologia',
      licenseNumber: `CRM-${Date.now()}`,
      phoneNumber: '11988888888',
      ...overrides
    });
    this.created.push({ model: Doctor, id: doctor._id });
    return doctor;
  }

  async package(data, overrides = {}) {
    const pkg = await Package.create({
      patient: data.patient._id,
      doctor: data.doctor._id,
      durationMonths: 1,
      sessionsPerWeek: 1,
      totalSessions: 10,
      sessionsDone: 0,
      totalValue: 2000,
      totalPaid: 0,
      sessionValue: 200,
      paymentType: 'per-session',
      specialty: 'psicologia',
      sessionType: 'psicologia',
      date: new Date(),
      ...overrides
    });
    this.created.push({ model: Package, id: pkg._id });
    return pkg;
  }

  async appointment(data, overrides = {}) {
    const appointment = await Appointment.create({
      patient: data.patient._id,
      doctor: data.doctor._id,
      package: data.package?._id,
      date: new Date(),
      time: '10:00',
      specialty: 'psicologia',
      sessionValue: 200,
      clinicalStatus: 'pending',
      operationalStatus: 'scheduled',
      ...overrides
    });
    this.created.push({ model: Appointment, id: appointment._id });
    return appointment;
  }

  async session(data, overrides = {}) {
    const session = await Session.create({
      patient: data.patient._id,
      doctor: data.doctor._id,
      package: data.package?._id,
      appointment: data.appointment?._id,
      date: new Date(),
      time: '10:00',
      specialty: 'psicologia',
      sessionValue: 200,
      status: 'scheduled',
      isPaid: false,
      paymentStatus: 'pending',
      ...overrides
    });
    this.created.push({ model: Session, id: session._id });
    return session;
  }

  async cleanup() {
    // Limpa na ordem inversa (dependências)
    for (const item of this.created.reverse()) {
      await item.model.deleteOne({ _id: item.id });
    }
    this.created = [];
  }
}

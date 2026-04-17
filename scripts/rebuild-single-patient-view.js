#!/usr/bin/env node
/**
 * 🔄 Rebuild de uma única patient view
 * Uso: node scripts/rebuild-single-patient-view.js <patientId>
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function main() {
  const patientId = process.argv[2];
  if (!patientId) {
    console.error('Usage: node scripts/rebuild-single-patient-view.js <patientId>');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected. Rebuilding view for', patientId);

  const view = await buildPatientView(patientId, { force: true, correlationId: 'manual-fix' });

  if (view) {
    console.log('✅ View rebuilt successfully!');
    console.log('  Version:', view.snapshot?.version);
    console.log('  Appointments:', view.stats?.totalAppointments);
    console.log('  Last Appointment:', view.lastAppointment?.date);
    console.log('  Next Appointment:', view.nextAppointment?.date);
  } else {
    console.log('❌ Patient not found, view not built');
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

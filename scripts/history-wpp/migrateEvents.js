// scripts/migrateEvents.js
import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import Session from '../../models/Session.js';
import { syncEvent } from '../../services/syncService.js';

const migrate = async () => {
  const appointments = await Appointment.find();
  for (const app of appointments) {
    await syncEvent(app, 'appointment');
  }

  const sessions = await Session.find();
  for (const session of sessions) {
    await syncEvent(session, 'session');
  }

  const packages = await Package.find();
  for (const pkg of packages) {
    await syncEvent(pkg, 'package');
  }

};

mongoose.connect(process.env.MONGO_URI)
  .then(() => migrate())
  .finally(() => mongoose.disconnect());
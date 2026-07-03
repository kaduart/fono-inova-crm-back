import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';
const APPOINTMENTS = [
  '6a47b7670b1d4720a17fcee8', // Alencar Rafael
  '6a4650b8f36c254eafc432e2', // João Marcos
];

await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const db = mongoose.connection.db;

for (const id of APPOINTMENTS) {
  console.log(`\n\n========================================`);
  console.log(`TRACING APPOINTMENT: ${id}`);
  console.log(`========================================`);

  const appt = await db.collection('appointments').findOne({ _id: new mongoose.Types.ObjectId(id) });
  console.log('\n--- APPOINTMENT STATE ---');
  console.log({
    operationalStatus: appt?.operationalStatus,
    clinicalStatus: appt?.clinicalStatus,
    paymentStatus: appt?.paymentStatus,
    isPaid: appt?.isPaid,
    completedAt: appt?.completedAt,
    _fromCompleteService: appt?._fromCompleteService,
    correlationId: appt?.correlationId,
    history: appt?.history?.map(h => ({ action: h.action, newStatus: h.newStatus, timestamp: h.timestamp, context: h.context }))
  });

  // Audit logs
  const audits = await db.collection('auditlogs')
    .find({ entityId: id })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`\n--- AUDITLOGS (${audits.length}) ---`);
  for (const a of audits) {
    console.log({
      action: a.action,
      source: a.source,
      createdAt: a.createdAt,
      user: a.user?.toString?.(),
      metadata: a.metadata,
      beforeOperationalStatus: a.before?.operationalStatus,
      afterOperationalStatus: a.after?.operationalStatus,
      beforeClinicalStatus: a.before?.clinicalStatus,
      afterClinicalStatus: a.after?.clinicalStatus,
      correlationId: a.correlationId
    });
  }

  // Event stores
  const events = await db.collection('eventstores')
    .find({ aggregateId: id })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`\n--- EVENTSTORES (${events.length}) ---`);
  for (const e of events) {
    console.log({
      type: e.type,
      status: e.status,
      createdAt: e.createdAt,
      processedAt: e.processedAt,
      correlationId: e.correlationId,
      payload: e.payload
    });
  }

  // Medical events
  const medEvents = await db.collection('medicalevents')
    .find({ 'payload.appointmentId': id })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`\n--- MEDICALEVENTS (${medEvents.length}) ---`);
  for (const e of medEvents) {
    console.log({
      eventType: e.eventType,
      createdAt: e.createdAt,
      payload: e.payload
    });
  }

  // Financial events
  const finEvents = await db.collection('financialevents')
    .find({ 'payload.appointmentId': id })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`\n--- FINANCIALEVENTS (${finEvents.length}) ---`);
  for (const e of finEvents) {
    console.log({
      type: e.type,
      createdAt: e.createdAt,
      payload: e.payload
    });
  }
}

await mongoose.disconnect();
console.log('\nDisconnected');

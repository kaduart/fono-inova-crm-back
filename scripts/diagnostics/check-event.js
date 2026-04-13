import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');

const EventStore = (await import('./models/EventStore.js')).default;
const events = await EventStore.find({
  eventType: 'BALANCE_UPDATE_REQUESTED',
  'payload.patientId': '69cab94949eddc65b58f48f3'
}).sort({ createdAt: -1 }).limit(5).lean();

console.log('Eventos BALANCE_UPDATE_REQUESTED:');
events.forEach(e => {
  console.log(`  ${e.eventId} - ${e.status} - ${e.payload?.amount}`);
});

await mongoose.disconnect();

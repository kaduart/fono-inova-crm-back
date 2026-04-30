import mongoose from 'mongoose';
const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;

// Rafael Barros Santos
console.log('=== RAFAEL BARROS SANTOS ===');
const rafaelAppt = await db.collection('appointments').findOne({ _id: new mongoose.Types.ObjectId('69e8c8eae52ed393a2581304') });
const rafaelSession = rafaelAppt?.session ? await db.collection('sessions').findOne({ _id: rafaelAppt.session }) : null;
const rafaelPayments = await db.collection('payments').find({ appointment: new mongoose.Types.ObjectId('69e8c8eae52ed393a2581304') }).toArray();
console.log('appointment paymentStatus:', rafaelAppt?.paymentStatus);
console.log('appointment isPaid:', rafaelAppt?.isPaid);
console.log('appointment balanceAmount:', rafaelAppt?.balanceAmount);
console.log('appointment billingType:', rafaelAppt?.billingType);
console.log('appointment package:', rafaelAppt?.package?.toString());
console.log('session paymentOrigin:', rafaelSession?.paymentOrigin);
console.log('session paymentStatus:', rafaelSession?.paymentStatus);
console.log('session isPaid:', rafaelSession?.isPaid);
console.log('payments count:', rafaelPayments.length);
for (const p of rafaelPayments) {
  console.log('  payment:', p._id.toString(), 'amount:', p.amount, 'status:', p.status, 'kind:', p.kind, 'isFromPackage:', p.isFromPackage);
}

// Serena
console.log('\n=== SERENA CHAPINOTTI ===');
const serenaAppt = await db.collection('appointments').findOne({ _id: new mongoose.Types.ObjectId('69f11b4700e59de10bf9262b') });
const serenaSession = serenaAppt?.session ? await db.collection('sessions').findOne({ _id: serenaAppt.session }) : null;
const serenaPayments = await db.collection('payments').find({ appointment: new mongoose.Types.ObjectId('69f11b4700e59de10bf9262b') }).toArray();
console.log('appointment paymentStatus:', serenaAppt?.paymentStatus);
console.log('appointment isPaid:', serenaAppt?.isPaid);
console.log('appointment balanceAmount:', serenaAppt?.balanceAmount);
console.log('appointment billingType:', serenaAppt?.billingType);
console.log('appointment package:', serenaAppt?.package?.toString());
console.log('session paymentOrigin:', serenaSession?.paymentOrigin);
console.log('session paymentStatus:', serenaSession?.paymentStatus);
console.log('session isPaid:', serenaSession?.isPaid);
console.log('payments count:', serenaPayments.length);
for (const p of serenaPayments) {
  console.log('  payment:', p._id.toString(), 'amount:', p.amount, 'status:', p.status, 'kind:', p.kind);
}

await mongoose.disconnect();

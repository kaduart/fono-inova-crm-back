/**
 * Fix: marca payments de hoje que ficaram presos como 'pending' → 'paid'
 * Ocorre quando paymentWorker criava pending mas confirmPayment nunca era chamado.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));

const now = new Date();
// Brasília UTC-3: hoje começa às 03:00 UTC
const startOfToday = new Date();
startOfToday.setUTCHours(3, 0, 0, 0);
if (now.getUTCHours() < 3) {
    startOfToday.setDate(startOfToday.getDate() - 1);
}

const endOfToday = new Date(startOfToday);
endOfToday.setUTCHours(endOfToday.getUTCHours() + 24);

console.log('Range:', startOfToday.toISOString(), '→', endOfToday.toISOString());

const result = await Payment.updateMany(
    {
        status: 'pending',
        $or: [
            { paymentDate: { $gte: startOfToday, $lte: endOfToday } },
            { createdAt: { $gte: startOfToday, $lte: endOfToday } }
        ]
    },
    {
        $set: {
            status: 'paid',
            paidAt: new Date(),
            confirmedAt: new Date(),
            updatedAt: new Date()
        }
    }
);

console.log(`✅ Payments corrigidos: ${result.modifiedCount}`);
await mongoose.disconnect();

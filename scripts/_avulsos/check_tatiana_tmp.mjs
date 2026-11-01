import mongoose from 'mongoose';
import 'dotenv/config';

await mongoose.connect(process.env.MONGO_URI);
const Doctor = mongoose.model('Doctor', new mongoose.Schema({}, { strict: false }), 'doctors');
const docs = await Doctor.find({ fullName: /tatiana/i }).lean();
console.log(JSON.stringify(docs.map(d => ({ _id: d._id, fullName: d.fullName, specialty: d.specialty, specialties: d.specialties })), null, 2));
await mongoose.disconnect();

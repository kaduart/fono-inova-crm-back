// models/TherapySession.js
import mongoose from 'mongoose';

const therapySessionSchema = new mongoose.Schema({
  doctor: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true 
  },
  patient: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true 
  },
  appointment: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment' 
  },
  duration: Number,
  notes: String,
  // ... outros campos
});

export default mongoose.model('TherapySession', therapySessionSchema);
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

async function checkData() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const patient = await Patient.findOne({ fullName: /Henre Gabriel/i });
        if (!patient) {
            console.log('Patient not found');
            return;
        }
        console.log('Patient found:', { _id: patient._id, fullName: patient.fullName });

        // Check for appointments around 04/03/2026
        const appointments = await Appointment.find({
            patient: patient._id,
            date: { $regex: /2026-03-04/ }
        }).sort({ createdAt: -1 });
        console.log(`Found ${appointments.length} appointments for 04/03/2026`);
        appointments.forEach(a => {
            console.log(`- Appt: ${a._id}, Date: ${a.date}, Time: ${a.time}, Status: ${a.operationalStatus}, ServiceType: ${a.serviceType}`);
        });

        // Check for payments created today
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const payments = await Payment.find({
            patient: patient._id,
            createdAt: { $gte: startOfToday }
        }).sort({ createdAt: -1 });
        console.log(`Found ${payments.length} payments created today`);
        payments.forEach(p => {
            console.log(`- Payment: ${p._id}, Amount: ${p.amount}, Date: ${p.paymentDate}, Status: ${p.status}, Appt: ${p.appointment}, Session: ${p.session}, ServiceType: ${p.serviceType}`);
        });

        // Check for sessions for 04/03/2026
        const sessions = await Session.find({
            patient: patient._id,
            date: { $regex: /2026-03-04/ }
        }).sort({ createdAt: -1 });
        console.log(`Found ${sessions.length} sessions for 04/03/2026`);
        sessions.forEach(s => {
            console.log(`- Session: ${s._id}, Date: ${s.date}, Status: ${s.status}, Appt: ${s.appointmentId}, ServiceType: ${s.serviceType}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkData();

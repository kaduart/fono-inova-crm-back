import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Appointment from '../models/Appointment.js';

async function checkHistory() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const apptId = '69a6dff3f70ff0b9ec22cdb0';
        const appt = await Appointment.findById(apptId).lean();

        if (!appt) {
            console.log('Appointment not found');
            return;
        }

        console.log('Appointment History for:', apptId);
        console.log(JSON.stringify(appt.history, null, 2));
        console.log('Full Appt Data:', JSON.stringify(appt, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkHistory();

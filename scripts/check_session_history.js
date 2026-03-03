import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Session from '../models/Session.js';

async function checkSessionHistory() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const sessionId = '69a6dff2f70ff0b9ec22cda5';
        const session = await Session.findById(sessionId).lean();

        if (!session) {
            console.log('Session not found');
            return;
        }

        console.log('Session History for:', sessionId);
        console.log(JSON.stringify(session.history, null, 2));
        console.log('Full Session Data:', JSON.stringify(session, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkSessionHistory();


import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';

const PHONE = '556299998888';

async function runDebug() {
    console.log("🐛 Debugging Tongue Tie Scenario (RN-06)...");

    if (!process.env.MONGO_URI) {
        console.error("❌ MONGO_URI missing");
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);

    // Setup Lead
    await Leads.deleteMany({ phone: PHONE });
    const lead = await Leads.create({
        name: 'Debug User',
        phone: PHONE,
        source: 'debug_script',
        stage: 'novo',
        qualificationData: { extractedInfo: {} }
    });

    const msg = "Vocês fazem a cirurgia do pique na linguinha?";
    console.log(`\n👤 User: "${msg}"`);

    const response = await getOptimizedAmandaResponse({
        content: msg,
        userText: msg,
        lead: lead,
        context: { source: 'whatsapp-inbound' }
    });

    const responseText = typeof response === 'string' ? response : (response?.payload?.text || JSON.stringify(response));
    console.log(`\n🤖 Amanda: ${responseText}`);

    const expected = ['não', 'realiza', 'cirurgia', 'teste', 'lingu', 'fono', 'reabilita'];
    const lower = responseText.toLowerCase();

    const missing = expected.filter(w => !lower.includes(w.toLowerCase()));

    if (missing.length === 0) {
        console.log("\n✅ PASS: All keywords found.");
    } else {
        console.error(`\n❌ FAIL: Missing keywords: ${missing.join(', ')}`);
    }

    await Leads.deleteMany({ phone: PHONE });
    process.exit(0);
}

runDebug();

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import { detectAllFlags } from '../../utils/flagsDetector.js';
import Leads from '../../models/Leads.js';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/crm_clinica_test';

async function runTest() {
    console.log('🚀 Starting Phase 9 Verification...');

    await mongoose.connect(MONGODB_URI);

    // Create a temporary lead
    const lead = await Leads.create({
        name: 'Test Phase 9',
        phone: '5562999999999',
        stage: 'novo',
        status: 'novo'
    });
    console.log(`👤 Temporary Lead created: ${lead._id}`);

    let failure = false;

    // ────────────────────────────────────────────────────────────────
    // TEST 1: Nota Fiscal
    // ────────────────────────────────────────────────────────────────
    console.log('\n📋 Test 1: Nota Fiscal Request');
    const msgNF = "Gostaria de uma nota fiscal por gentileza";
    const flagsNF = detectAllFlags(msgNF, lead, {});

    if (!flagsNF.wantsInvoice) {
        console.error('❌ FlagsDetector failed to detect wantsInvoice');
        failure = true;
    } else {
        console.log('✅ FlagsDetector detected wantsInvoice');
    }

    // Simulate Orchestrator Response
    const responseNF = await getOptimizedAmandaResponse({
        content: msgNF,
        userText: msgNF,
        lead: lead,
        context: {}
    });

    console.log('🤖 AI Response (NF):', responseNF);

    const expectedNF = ['nome completo', 'cpf', 'endereço', 'financeiro'];
    const lowerNF = responseNF?.toLowerCase() || "";
    const missingNF = expectedNF.filter(w => !lowerNF.includes(w));

    if (missingNF.length > 0) {
        console.error(`❌ AI Response missing keywords for NF: ${missingNF.join(', ')}`);
        failure = true;
    } else {
        console.log('✅ AI Response correctly asked for NF data');
    }

    // ────────────────────────────────────────────────────────────────
    // TEST 2: Tongue Tie Enrichment
    // ────────────────────────────────────────────────────────────────
    console.log('\n📋 Test 2: Tongue Tie Enrichment');
    const msgTT = "Como funciona o teste da linguinha?";

    // Simulate Orchestrator Response
    const responseTT = await getOptimizedAmandaResponse({
        content: msgTT,
        userText: msgTT,
        lead: lead,
        context: {}
    });

    console.log('🤖 AI Response (Tongue Tie):', responseTT);

    const expectedTT = ['pega', 'sucção', 'abocanhar', 'amamentação']; // 'indolor' might be missed by AI paraphrasing
    const lowerTT = responseTT?.toLowerCase() || "";
    const missingTT = expectedTT.filter(w => !lowerTT.includes(w));

    // Note: AI might not use ALL words, but should use some from the detailed script.
    if (missingTT.length > 2) { // Allow missing some, but must have richness
        console.error(`❌ AI Response missing too many rich keywords: ${missingTT.join(', ')}`);
        failure = true;
    } else {
        console.log('✅ AI Response contains rich Tongue Tie details');
    }

    // Cleanup
    await Leads.findByIdAndDelete(lead._id);
    await mongoose.disconnect();

    if (failure) {
        console.error('\n❌ Phase 9 Verification FAILED');
        process.exit(1);
    } else {
        console.log('\n✅ Phase 9 Verification PASSED');
        process.exit(0);
    }
}

runTest().catch(async err => {
    console.error('💥 Error:', err);
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    process.exit(1);
});

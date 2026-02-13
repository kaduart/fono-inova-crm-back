
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tests = [
    { name: 'Fix: Bad Response (Unimed/Plans)', script: 'verify_bad_response_fix.js' },
    { name: 'Logic: Psych vs Neuro Ambiguity', script: 'verify_psych_neuro_ambiguity.js' },
    { name: 'Logic: Tongue Tie & Scenarios', script: 'simulacao-conversa.test.js' }
];

async function runTest(test) {
    return new Promise((resolve, reject) => {
        console.log(`\n▶️  Running: ${test.name} (${test.script})...`);

        const child = spawn('node', [path.join(__dirname, test.script)], {
            stdio: 'inherit',
            env: { ...process.env, NODE_ENV: 'test' }
        });

        child.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ ${test.name}: PASSED`);
                resolve();
            } else {
                console.error(`❌ ${test.name}: FAILED (Exit Code ${code})`);
                reject(new Error(`Test failed: ${test.name}`));
            }
        });

        child.on('error', (err) => {
            console.error(`❌ ${test.name}: ERROR to start`, err);
            reject(err);
        });
    });
}

async function runAll() {
    console.log("🚀 Starting Regression Suite...");
    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            await runTest(test);
            passed++;
        } catch (e) {
            failed++;
        }
    }

    console.log("\n========================================");
    console.log(`🏁 Suite Finished.`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log("========================================");

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runAll();

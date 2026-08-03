/**
 * ============================================================================
 * POPULAR Convenio.issRate
 * ============================================================================
 *
 * Ajuste de dados (não altera lógica de negócio). O schema já prevê o campo
 * issRate em Convenio, mas muitos registros antigos não o possuem preenchido.
 * Sem esse valor, o cálculo automático de ISS no recebimento assume 0%.
 *
 * Modo dry-run por padrão. Use --apply para efetivar.
 *
 * Uso:
 *   node scripts/populate-convenio-iss-rate.js
 *     → mostra o que seria alterado (dry-run)
 *
 *   node scripts/populate-convenio-iss-rate.js --apply
 *     → aplica o mapa padrão (unimed-anapolis: 2.01)
 *
 *   node scripts/populate-convenio-iss-rate.js --apply \
 *     --map="unimed-anapolis:2.01,unimed-campinas:2.01,bradesco-saude:0"
 *     → aplica alíquotas customizadas por slug
 *
 *   node scripts/populate-convenio-iss-rate.js --apply --provider=unimed-anapolis --rate=2.01
 *     → atualiza apenas um convênio específico
 * ============================================================================
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRY_RUN = !process.argv.includes('--apply');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ROLLBACK_LOG_PATH = path.join(__dirname, '..', 'logs', `populate-iss-rate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

function ensureLogsDir() {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
}

function parseArgs() {
    const mapArg = process.argv.find(arg => arg.startsWith('--map='))?.split('=')[1];
    const providerArg = process.argv.find(arg => arg.startsWith('--provider='))?.split('=')[1];
    const rateArg = process.argv.find(arg => arg.startsWith('--rate='))?.split('=')[1];

    if (providerArg && rateArg !== undefined) {
        return { [providerArg.trim().toLowerCase()]: Number(rateArg) };
    }

    if (mapArg) {
        const map = {};
        for (const pair of mapArg.split(',')) {
            const [code, rate] = pair.split(':');
            if (code && rate !== undefined) {
                map[code.trim().toLowerCase()] = Number(rate);
            }
        }
        return map;
    }

    // Mapa padrão: só Unimed Anápolis — ajuste se outros convênios tiverem ISS
    return { 'unimed-anapolis': 2.01 };
}

async function main() {
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI não encontrado no .env');
        process.exit(1);
    }

    const rateMap = parseArgs();
    const codes = Object.keys(rateMap);

    console.log('='.repeat(70));
    console.log('POPULAR Convenio.issRate');
    console.log('='.repeat(70));
    console.log(`Modo: ${DRY_RUN ? '🔍 DRY-RUN (nada será salvo)' : '⚠️  EXECUÇÃO REAL'}`);
    console.log(`Convênios a atualizar: ${codes.length}`);
    for (const code of codes) {
        console.log(`  • ${code} → ${rateMap[code]}%`);
    }
    console.log('='.repeat(70));

    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    const convenios = db.collection('convenios');

    const existing = await convenios.find({ code: { $in: codes } }).toArray();
    const existingByCode = Object.fromEntries(existing.map(c => [c.code, c]));

    ensureLogsDir();
    const log = [];

    for (const code of codes) {
        const convenio = existingByCode[code];
        if (!convenio) {
            console.log(`  ⚠️  Convênio não encontrado: ${code}`);
            log.push({ code, found: false, skipped: true });
            continue;
        }

        const newRate = rateMap[code];
        const oldRate = convenio.issRate;

        if (oldRate === newRate) {
            console.log(`  ✓ ${code} já está com issRate=${oldRate}`);
            log.push({ code, found: true, changed: false, oldRate, newRate });
            continue;
        }

        if (!DRY_RUN) {
            await convenios.updateOne(
                { _id: convenio._id },
                { $set: { issRate: newRate, updatedAt: new Date() } }
            );
            log.push({ code, found: true, changed: true, oldRate, newRate, convenioId: convenio._id.toString() });
        }

        console.log(`  ${DRY_RUN ? '🔍' : '✅'} ${code}: issRate ${oldRate ?? 'undefined'} → ${newRate}`);
    }

    fs.writeFileSync(ROLLBACK_LOG_PATH, JSON.stringify({
        timestamp: new Date().toISOString(),
        dryRun: DRY_RUN,
        rateMap,
        log
    }, null, 2));

    console.log('='.repeat(70));
    console.log(`📝 Log salvo em: ${ROLLBACK_LOG_PATH}`);
    if (DRY_RUN) {
        console.log('💡 Para aplicar de verdade, rode com: --apply');
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
});

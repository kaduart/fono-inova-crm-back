// 🔧 Script de migração: Normaliza todos os sessionType existentes
// MODO DRY-RUN por padrão — revise antes de executar de verdade
// 
// USO:
//   DRY_RUN=true node migrate-session-types.js    (só visualiza)
//   DRY_RUN=false node migrate-session-types.js   (executa de verdade)

import mongoose from 'mongoose';
import Session from '../models/Session.js';
import dotenv from 'dotenv';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false'; // default: true
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

// Valores válidos esperados (após normalização)
const VALID_TYPES = [
    'fonoaudiologia',
    'psicologia',
    'terapia ocupacional',
    'fisioterapia',
    'pediatria',
    'neuroped',
    'musicoterapia',
    'psicomotricidade',
    'psicopedagogia'
];

// Função de normalização (igual ao modelo)
function normalize(v) {
    if (!v) return null;
    return v.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

async function migrate() {
    console.log('========================================');
    console.log(`🔧 MIGRAÇÃO DE SESSION TYPES`);
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (só visualiza)' : 'EXECUÇÃO REAL (vai alterar)'}`);
    console.log('========================================\n');

    console.log('🔗 Conectando ao MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado!\n');

    // 1. Buscar TODAS as sessions (incluindo sem sessionType)
    const allSessions = await Session.find({});
    console.log(`📊 Total de sessões no banco: ${allSessions.length}\n`);

    // 2. Categorizar
    const comTipo = [];
    const semTipo = [];
    const tiposInvalidos = [];
    const tiposValidos = [];

    allSessions.forEach(s => {
        if (!s.sessionType || s.sessionType.trim() === '') {
            semTipo.push(s);
        } else {
            comTipo.push(s);
            const normalizado = normalize(s.sessionType);
            
            if (VALID_TYPES.includes(normalizado)) {
                tiposValidos.push({ session: s, original: s.sessionType, normalizado });
            } else {
                tiposInvalidos.push({ session: s, original: s.sessionType, normalizado });
            }
        }
    });

    // 3. Relatório
    console.log('📋 ANÁLISE DO BANCO:\n');
    
    console.log(`   Com sessionType: ${comTipo.length}`);
    console.log(`   Sem sessionType: ${semTipo.length} ❌`);
    console.log(`   Tipos VÁLIDOS: ${tiposValidos.length} ✅`);
    console.log(`   Tipos INVÁLIDOS: ${tiposInvalidos.length} ⚠️`);
    
    if (tiposInvalidos.length > 0) {
        console.log('\n   ⚠️  VALORES INVÁLIDOS ENCONTRADOS:');
        const agrupado = {};
        tiposInvalidos.forEach(({ original, normalizado }) => {
            const key = `"${original}" → "${normalizado}"`;
            agrupado[key] = (agrupado[key] || 0) + 1;
        });
        Object.entries(agrupado).forEach(([key, count]) => {
            console.log(`      ${key} (${count}x)`);
        });
        console.log('\n   💡 Esses valores PRECISAM ser corrigidos MANUALMENTE antes da migração!');
    }

    // 4. Valores atuais (agrupados)
    console.log('\n📋 VALORES ATUAIS (agrupados):');
    const porValor = {};
    comTipo.forEach(s => {
        const v = `"${s.sessionType}"`;
        porValor[v] = (porValor[v] || 0) + 1;
    });
    Object.entries(porValor).sort().forEach(([valor, count]) => {
        console.log(`   ${valor} → ${count} sessões`);
    });

    // 5. Simular migração
    console.log('\n📋 SIMULAÇÃO DE MUDANÇAS:\n');
    
    let aNormalizar = 0;
    let jaNormalizados = 0;

    tiposValidos.forEach(({ original, normalizado }) => {
        if (original !== normalizado) {
            console.log(`   🔄 "${original}" → "${normalizado}"`);
            aNormalizar++;
        } else {
            jaNormalizados++;
        }
    });

    console.log(`\n   Serão normalizados: ${aNormalizar}`);
    console.log(`   Já estão OK: ${jaNormalizados}`);
    console.log(`   SEM TIPO (requer atenção): ${semTipo.length}`);

    // 6. Sessões sem tipo (problema grave)
    if (semTipo.length > 0) {
        console.log('\n   ❌ SESSÕES SEM TIPO (requer correção manual):');
        semTipo.slice(0, 5).forEach(s => {
            console.log(`      - ${s._id} (date: ${s.date}, status: ${s.status})`);
        });
        if (semTipo.length > 5) {
            console.log(`      ... e mais ${semTipo.length - 5}`);
        }
    }

    // 7. EXECUTAR?
    if (DRY_RUN) {
        console.log('\n========================================');
        console.log('🛑 DRY RUN — Nenhuma alteração foi feita!');
        console.log('========================================');
        console.log('\nPara executar a migração de verdade:');
        console.log('   DRY_RUN=false node migrate-session-types.js');
        console.log('\n⚠️  ATENÇÃO: Corrija os tipos INVÁLIDOS antes!');
    } else {
        // EXECUÇÃO REAL
        console.log('\n========================================');
        console.log('🚀 EXECUTANDO MIGRAÇÃO...');
        console.log('========================================\n');

        let atualizadas = 0;
        let erros = 0;

        // Só atualiza as VÁLIDAS que precisam normalização
        for (const { session, normalizado } of tiposValidos) {
            if (session.sessionType !== normalizado) {
                try {
                    await Session.updateOne(
                        { _id: session._id },
                        { $set: { sessionType: normalizado } }
                    );
                    console.log(`   ✅ ${session._id}: "${session.sessionType}" → "${normalizado}"`);
                    atualizadas++;
                } catch (err) {
                    console.error(`   ❌ Erro em ${session._id}:`, err.message);
                    erros++;
                }
            }
        }

        console.log('\n========================================');
        console.log('📊 RESULTADO:');
        console.log(`   Atualizadas: ${atualizadas}`);
        console.log(`   Erros: ${erros}`);
        console.log('========================================');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
}

migrate().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});

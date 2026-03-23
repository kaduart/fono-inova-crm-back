#!/usr/bin/env node
/**
 * 🌐 TESTE DE MENSAGENS DO SITE — Fono Inova
 * 
 * Pega todas as mensagens pré-definidas dos botões do site
 * e testa como a Amanda responde a cada uma.
 * 
 * Isso garante que as mensagens do site funcionam bem com a Amanda!
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// 🛡️ PROTEÇÃO: Modo replay
process.env.AMANDA_REPLAY_MODE = 'true';
process.env.DISABLE_WEBHOOKS = 'true';
process.env.DISABLE_FOLLOWUP = 'true';

import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// MENSAGENS EXTRAÍDAS DO SITE (29 páginas)
// ═══════════════════════════════════════════════════════════

const MENSAGENS_SITE = [
  // Home / Geral
  { msg: "Oi! Vi o site da Clínica Fono Inova 💚 É para meu filho, pode me orientar?", pagina: "Home", intencao: "primeiro contato" },
  { msg: "Oi! Vi o site da Clínica Fono Inova 💚 Quero avaliação neuropsicológica.", pagina: "Home", intencao: "agendamento neuro" },
  { msg: "Oi! Vi o site de vocês e gostei muito da clínica.\n\nQueria tirar uma dúvida sobre o atendimento. Pode me ajudar?", pagina: "Home", intencao: "duvida geral" },
  { msg: "Oi! Vi o endereço de vocês no site.\n\nPode me orientar como chegar na clínica?", pagina: "Home", intencao: "localizacao" },
  
  // Dislexia
  { msg: "Oi! Vi no site sobre dislexia. Meu filho está no 1º ano e tem dificuldade para ler/confunde letras. Pode me explicar como funciona a avaliação?", pagina: "Dislexia", intencao: "dislexia 1 ano" },
  { msg: "Oi! Vi no site sobre dislexia. Meu filho está no 2º ano e inverte sílabas/tem dificuldade de compreensão. Pode me explicar como funciona a avaliação?", pagina: "Dislexia", intencao: "dislexia 2 ano" },
  { msg: "Oi! Vi no site sobre dislexia. Meu filho está no 3º ano ou mais e tem dificuldade persistente para ler. Pode me explicar como funciona a avaliação?", pagina: "Dislexia", intencao: "dislexia 3+ ano" },
  { msg: "Oi! Vi no site sobre dificuldade para ler e me identifiquei.\n\nMeu filho(a) tem dificuldade com leitura e troca letras. Pode me explicar como funciona a avaliação?", pagina: "Dislexia", intencao: "dificuldade leitura" },
  { msg: "Oi! Vi no site sobre dificuldade para ler e me identifiquei.\n\nPode me explicar como funciona a avaliação?", pagina: "Dislexia", intencao: "dificuldade leitura generica" },
  
  // TEA (Autismo)
  { msg: "Oi! Vi no site sobre avaliação de autismo e fiquei com algumas dúvidas.\n\nTenho percebido alguns comportamentos no meu filho(a) e queria entender melhor. Pode me explicar como funciona a avaliação?", pagina: "TEA", intencao: "suspeita autismo" },
  { msg: "Oi! Vi no site sobre avaliação de autismo e fiquei com algumas dúvidas.\n\nTenho percebido alguns comportamentos no meu filho(a) e queria entender melhor. Pode me explicar como funciona a avaliação?", pagina: "TEA", intencao: "suspeita autismo 2" },
  
  // TDAH
  { msg: "Oi! Vi no site sobre dificuldade de atenção e me chamou atenção.\n\nMeu filho(a) é muito inquieto(a) e tem dificuldade de focar. Pode me explicar como funciona a avaliação?", pagina: "TDAH", intencao: "tdah inquieto" },
  { msg: "Oi! Vi no site sobre dificuldade de atenção e me chamou atenção.\n\nMeu filho(a) é muito inquieto(a). Pode me explicar como funciona a avaliação?", pagina: "TDAH", intencao: "tdah inquieto simples" },
  { msg: "Oi! Vi no site sobre dificuldade de atenção e me chamou atenção.\n\nPode me explicar como funciona a avaliação?", pagina: "TDAH", intencao: "tdah geral" },
  
  // Fala Tardia
  { msg: "Oi! Vi no site sobre fala tardia e me identifiquei.\n\nMeu filho(a) ainda não fala muito bem e isso tem me preocupado. Pode me explicar como funciona a avaliação?", pagina: "Fala Tardia", intencao: "fala tardia preocupacao" },
  { msg: "Oi! Vi no site sobre fala tardia e me identifiquei.\n\nMeu filho(a) tem atraso na fala. Pode me explicar como funciona a avaliação?", pagina: "Fala Tardia", intencao: "atraso fala" },
  { msg: "Oi! Vi no site sobre fala tardia e me identifiquei.\n\nQueria entender melhor como funciona o tratamento. Pode me explicar?", pagina: "Fala Tardia", intencao: "tratamento fala" },
  
  // Fonoaudiologia
  { msg: "Oi! Vi no site de vocês e gostaria de entender melhor como funciona a avaliação fonoaudiológica.\n\nPode me explicar?", pagina: "Fonoaudiologia", intencao: "avaliacao fono" },
  { msg: "Oi! Vi no site de vocês e gostaria de entender melhor como funciona a avaliação fonoaudiológica.\n\nÉ para meu filho(a). Pode me explicar?", pagina: "Fonoaudiologia", intencao: "avaliacao fono filho" },
  
  // Psicologia Infantil
  { msg: "Oi! Vi no site sobre avaliação psicológica e queria entender melhor.\n\nPode me explicar como funciona?", pagina: "Psicologia", intencao: "avaliacao psico" },
  { msg: "Oi! Vi no site sobre avaliação psicológica e queria entender melhor.\n\nÉ para meu filho(a). Pode me explicar como funciona?", pagina: "Psicologia", intencao: "avaliacao psico filho" },
  
  // Terapia Ocupacional
  { msg: "Oi! Vi no site sobre terapia ocupacional e fiquei com dúvida.\n\nPode me explicar como funciona a avaliação?", pagina: "Terapia Ocupacional", intencao: "avaliacao to" },
  { msg: "Oi! Vi no site sobre terapia ocupacional e fiquei com dúvida.\n\nÉ para meu filho(a). Pode me explicar como funciona a avaliação?", pagina: "Terapia Ocupacional", intencao: "avaliacao to filho" },
  
  // Fisioterapia Infantil
  { msg: "Oi! Vi o site sobre Fisioterapia Infantil em Anápolis 💚\nMeu filho tem dificuldade de postura/movimento. Pode me orientar?", pagina: "Fisioterapia", intencao: "fisio postura" },
  { msg: "Oi! Vi o site sobre Fisioterapia Infantil 💚\nQuero agendar uma avaliação para meu filho.", pagina: "Fisioterapia", intencao: "agendar fisio" },
  { msg: "Oi! Vi o site sobre Fisioterapia Infantil 💚\nQuero saber se meu filho precisa de atendimento.", pagina: "Fisioterapia", intencao: "duvida fisio" },
  { msg: "Oi! Vi no site sobre fisioterapia pediátrica.\n\nQueria entender melhor como funciona a avaliação. Pode me explicar?", pagina: "Fisioterapia", intencao: "avaliacao fisio" },
  { msg: "Oi! Vi no site sobre fisioterapia pediátrica.\n\nQueria entender melhor como funciona. Pode me exrender?", pagina: "Fisioterapia", intencao: "fisio geral" },
  
  // Neuropsicologia
  { msg: "Oi! Vi no site sobre avaliação neuropsicológica e queria entender melhor.\n\nPode me explicar como funciona?", pagina: "Neuropsicologia", intencao: "avaliacao neuropsico" },
  { msg: "Oi! Vi no site sobre avaliação neuropsicológica e queria entender melher.\n\nÉ para meu filho(a). Pode me explicar como funciona?", pagina: "Neuropsicologia", intencao: "avaliacao neuropsico filho" },
  { msg: "Meu filho tem muita dificuldade com lição de casa. Quero agendar avaliação neuropsicológica no Jundiaí.", pagina: "Neuropsicologia", intencao: "neuro dificuldade licao" },
  
  // Psicopedagogia
  { msg: "Oi! Vi no site sobre psicopedagogia e me identifiquei.\n\nMeu filho(a) está com dificuldade de aprendizagem. Pode me explicar como funciona?", pagina: "Psicopedagogia", intencao: "psicoped dificuldade" },
  { msg: "Oi! Vi no site sobre psicopedagogia e me identifiquei.\n\nPode me explicar como funciona?", pagina: "Psicopedagogia", intencao: "psicoped geral" },
  { msg: "Oi! Vi no site sobre psicopedagogia e me identifiquei.\n\nQueria entender melhor como funciona. Pode me explicar?", pagina: "Psicopedagogia", intencao: "psicoped info" },
  
  // Dificuldade Escolar
  { msg: "Oi! Vi no site sobre dificuldade escolar e me identifiquei.\n\nMeu filho(a) está com dificuldade na escola e queria entender melhor como vocês podem ajudar. Pode me explicar?", pagina: "Dificuldade Escolar", intencao: "dificuldade escolar" },
  
  // Síndrome de Down
  { msg: "Oi! Vi o site sobre Síndrome de Down em Anápolis 💚 Quero agendar uma avaliação para meu filho.", pagina: "Sindrome de Down", intencao: "down agendar" },
  { msg: "Oi! Vi o site sobre Síndrome de Down em Anápolis 💚 Quero agendar uma avaliação.", pagina: "Sindrome de Down", intencao: "down avaliacao" },
  
  // Prematuridade
  { msg: "Oi! Vi o site sobre acompanhamento para prematuros em Anápolis 💚 Quero agendar uma avaliação para meu bebê.", pagina: "Prematuridade", intencao: "prematuro bebe" },
  { msg: "Oi! Vi o site sobre acompanhamento para prematuros em Anápolis 💚 Quero agendar uma avaliação.", pagina: "Prematuridade", intencao: "prematuro avaliacao" },
  
  // Teste da Linguinha
  { msg: "Oi! Vi o site sobre Teste da Linguinha 💚\nQuero agendar uma avaliação para meu filho.", pagina: "Teste Linguinha", intencao: "linguinha agendar" },
  { msg: "Oi! Vi o site sobre Teste da Linguinha 💚\nQuero saber se meu filho precisa fazer o teste.", pagina: "Teste Linguinha", intencao: "linguinha teste" },
  { msg: "Oi! Vi no site sobre freio lingual.\n\nQueria entender melhor como funciona o teste da linguinha. Pode me explicar?", pagina: "Freio Lingual", intencao: "freio lingual teste" },
  { msg: "Oi! Vi no site sobre freio lingual.\n\nQueria entender melhor como funciona. Pode me explicar?", pagina: "Freio Lingual", intencao: "freio lingual geral" },
  
  // Musicoterapia
  { msg: "Oi! Vi no site sobre musicoterapia e achei interessante.\n\nQueria entender melhor como funciona para meu filho(a). Pode me explicar?", pagina: "Musicoterapia", intencao: "musicoterapia filho" },
  { msg: "Oi! Vi no site sobre musicoterapia e achei interessante.\n\nQueria entender melhor como funciona. Pode me explicar?", pagina: "Musicoterapia", intencao: "musicoterapia geral" },
  
  // Psicomotricidade
  { msg: "Oi! Vi no site sobre psicomotricidade e queria entender melhor.\n\nPode me explicar como funciona a avaliação?", pagina: "Psicomotricidade", intencao: "psicomot avaliacao" },
  { msg: "Oi! Vi no site sobre psicomotricidade e queria entender melhor.\n\nPode me explicar como funciona?", pagina: "Psicomotricidade", intencao: "psicomot geral" },
  
  // Adulto
  { msg: "Oi! Vi no site sobre atendimento para adultos.\n\nPode me explicar como funciona a avaliação?", pagina: "Adulto", intencao: "adulto avaliacao" },
  { msg: "Oi! Vi no site sobre atendimento para adultos.\n\nTenho interesse em avaliação de voz/deglutição. Pode me explicar como funciona?", pagina: "Adulto", intencao: "adulto voz" },
  
  // Geral
  { msg: "Oi! Vi no site de vocês e queria entender melhor como funciona a avaliação completa.\n\nPode me explicar?", pagina: "Geral", intencao: "avaliacao completa" },
  { msg: "Oi! Vi no site de vocês e queria entender melhor como funciona a avaliação completa.\n\nÉ para meu filho(a). Pode me explicar?", pagina: "Geral", intencao: "avaliacao completa filho" },
  { msg: "Oi! Vi o site sobre avaliação infantil 💚\nQuero agendar para meu filho.", pagina: "Geral", intencao: "agendar infantil" },
];

// ═══════════════════════════════════════════════════════════
// FUNÇÕES
// ═══════════════════════════════════════════════════════════

function makeFreshLead() {
  return {
    _id: new mongoose.Types.ObjectId(),
    stage: 'novo',
    messageCount: 0,
    contact: {
      _id: new mongoose.Types.ObjectId(),
      phone: '5562999990000',
      name: 'Lead Site Test',
    },
    tags: [],
  };
}

async function run() {
  console.log('📡 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado!\n');

  console.log(`🌐 TESTANDO ${MENSAGENS_SITE.length} MENSAGENS DO SITE\n`);

  const results = [];
  
  for (let i = 0; i < MENSAGENS_SITE.length; i++) {
    const item = MENSAGENS_SITE[i];
    
    console.log(`[${i + 1}/${MENSAGENS_SITE.length}] ${item.pagina} — ${item.intencao}`);
    console.log(`    "${item.msg.substring(0, 60)}..."`);
    
    try {
      const resposta = await getOptimizedAmandaResponse({
        content: item.msg,
        userText: item.msg,
        lead: makeFreshLead(),
        context: { 
          source: 'lp',  // 🆕 Indica que veio do site
          lpPage: item.pagina,  // 🆕 Página específica
          lpIntent: item.intencao,  // 🆕 Intenção
          isReplay: true
        },
        messageId: `site-test-${i}`,
      });
      
      const textoResposta = resposta?.text || resposta || '[SEM RESPOSTA]';
      
      results.push({
        ...item,
        respostaAmanda: textoResposta,
        status: 'ok'
      });
      
      console.log(`    ✅ ${textoResposta.length} chars`);
      
    } catch (err) {
      console.log(`    ❌ ERRO: ${err.message}`);
      results.push({
        ...item,
        respostaAmanda: `[ERRO: ${err.message}]`,
        status: 'erro'
      });
    }
    
    await new Promise(r => setTimeout(r, 100));
  }

  // Gera relatório
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `RELATORIO-TESTE-SITE-FONO-INOVA-${timestamp}.md`;
  const filepath = path.join(process.cwd(), 'tests-amanda-ouro', 'relatorios', filename);

  let markdown = `# 🌐 RELATÓRIO TESTE — Mensagens do Site Fono Inova

**Gerado em:** ${new Date().toLocaleString('pt-BR')}  
**Total de mensagens testadas:** ${results.length}  
**Fonte:** 29 páginas do site

---

## 📊 RESUMO POR PÁGINA

`;

  // Agrupa por página
  const porPagina = {};
  results.forEach(r => {
    if (!porPagina[r.pagina]) porPagina[r.pagina] = [];
    porPagina[r.pagina].push(r);
  });

  Object.entries(porPagina).forEach(([pagina, itens]) => {
    markdown += `- **${pagina}:** ${itens.length} mensagens\n`;
  });

  markdown += `\n---\n\n`;

  // Detalhes de cada mensagem
  results.forEach((r, idx) => {
    markdown += `## ${idx + 1}. ${r.pagina} — ${r.intencao}\n\n`;
    markdown += `**👤 MENSAGEM DO SITE:**\n`;
    markdown += `\`\`\`\n${r.msg}\n\`\`\`\n\n`;
    markdown += `**🤖 RESPOSTA DA AMANDA:**\n`;
    markdown += `\`\`\`\n${r.respostaAmanda}\n\`\`\`\n\n`;
    markdown += `**📋 AVALIAÇÃO:**\n\n`;
    markdown += `- [ ] Excelente (resposta perfeita)\n`;
    markdown += `- [ ] Boa (aceitável)\n`;
    markdown += `- [ ] Precisa ajustar (problema identificado)\n\n`;
    markdown += `**📝 Observação:**\n`;
    markdown += `\`\`\`\n[Anote aqui o que precisa melhorar...]\n\`\`\`\n\n`;
    markdown += `---\n\n`;
  });

  fs.writeFileSync(filepath, markdown);

  console.log(`\n${'═'.repeat(64)}`);
  console.log('✅ TESTE CONCLUÍDO!');
  console.log(`${'═'.repeat(64)}`);
  console.log(`\n📄 Relatório salvo em:`);
  console.log(`   ${filepath}`);
  console.log(`\n📊 Resumo:`);
  console.log(`   • ${results.length} mensagens testadas`);
  console.log(`   • ${results.filter(r => r.status === 'erro').length} erros`);
  console.log(`   • ${Object.keys(porPagina).length} páginas cobertas`);
  console.log(`\n💡 Próximo passo:`);
  console.log(`   Abra o relatório e verifique se as respostas`);
  console.log(`   da Amanda estão adequadas para cada página!\n`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('💥 ERRO:', err);
  process.exit(1);
});

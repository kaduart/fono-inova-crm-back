#!/usr/bin/env node
/**
 * 🌐 TESTE MASTER — Mensagens do Site Fono Inova
 * 
 * Arquivo mestre que acumula todos os testes do site.
 * SEMPRE atualiza o mesmo arquivo, adicionando novas execuções.
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

process.env.AMANDA_REPLAY_MODE = 'true';
process.env.DISABLE_WEBHOOKS = 'true';
process.env.DISABLE_FOLLOWUP = 'true';

import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URI = process.env.MONGO_URI;

// Arquivo mestre único
const MASTER_FILE = path.join(process.cwd(), 'tests-amanda-ouro', 'RELATORIO-MASTER-SITE-FONO-INOVA.md');

// Mensagens do site (simplificado - as mais importantes)
const MENSAGENS_SITE = [
  { msg: "Oi! Vi o site sobre dislexia. Meu filho está no 1º ano e tem dificuldade para ler/confunde letras. Pode me explicar como funciona a avaliação?", pagina: "Dislexia", intencao: "dislexia" },
  { msg: "Oi! Vi no site sobre avaliação de autismo. Tenho percebido comportamentos no meu filho. Pode me explicar como funciona?", pagina: "TEA", intencao: "suspeita autismo" },
  { msg: "Oi! Vi no site sobre dificuldade de atenção. Meu filho é muito inquieto. Pode me explicar como funciona a avaliação?", pagina: "TDAH", intencao: "tdah" },
  { msg: "Oi! Vi no site sobre fala tardia. Meu filho ainda não fala muito bem. Pode me explicar como funciona a avaliação?", pagina: "Fala Tardia", intencao: "fala tardia" },
  { msg: "Oi! Vi o site sobre Teste da Linguinha. Quero agendar uma avaliação para meu filho.", pagina: "Teste Linguinha", intencao: "linguinha" },
  { msg: "Oi! Vi o site sobre Síndrome de Down. Quero agendar uma avaliação para meu filho.", pagina: "Sindrome de Down", intencao: "down" },
  { msg: "Oi! Vi no site sobre fisioterapia pediátrica. Queria entender melhor como funciona.", pagina: "Fisioterapia", intencao: "fisio" },
  { msg: "Oi! Vi no site sobre terapia ocupacional. Pode me explicar como funciona a avaliação?", pagina: "Terapia Ocupacional", intencao: "to" },
  { msg: "Oi! Vi no site sobre psicopedagogia. Meu filho está com dificuldade de aprendizagem.", pagina: "Psicopedagogia", intencao: "psicoped" },
  { msg: "Oi! Vi no site sobre avaliação neuropsicológica. É para meu filho. Pode me explicar?", pagina: "Neuropsicologia", intencao: "neuropsico" },
  { msg: "Oi! Vi no site sobre avaliação psicológica. É para meu filho. Pode me explicar?", pagina: "Psicologia", intencao: "psicologia" },
  { msg: "Oi! Vi no site sobre fonoaudiologia. É para meu filho. Pode me explicar?", pagina: "Fonoaudiologia", intencao: "fono" },
  { msg: "Oi! Vi o site da Clínica Fono Inova. É para meu filho, pode me orientar?", pagina: "Home", intencao: "geral" },
  { msg: "Oi! Vi no site sobre dificuldade escolar. Meu filho está com dificuldade na escola.", pagina: "Dificuldade Escolar", intencao: "dificuldade escolar" },
  { msg: "Oi! Vi o site sobre acompanhamento para prematuros. Quero agendar para meu bebê.", pagina: "Prematuridade", intencao: "prematuro" },
];

function makeFreshLead() {
  return {
    _id: new mongoose.Types.ObjectId(),
    stage: 'novo',
    messageCount: 0,
    contact: { _id: new mongoose.Types.ObjectId(), phone: '5562999990000', name: 'Lead Site' },
    tags: [],
  };
}

async function run() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🌐 TESTE MASTER — Site Fono Inova                             ║
║  Atualizando: RELATORIO-MASTER-SITE-FONO-INOVA.md              ║
╚════════════════════════════════════════════════════════════════╝
`);

  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB conectado\n');

  const execucaoId = new Date().toISOString();
  const resultados = [];

  for (let i = 0; i < MENSAGENS_SITE.length; i++) {
    const item = MENSAGENS_SITE[i];
    process.stdout.write(`[${i + 1}/${MENSAGENS_SITE.length}] ${item.pagina}... `);
    
    try {
      const resposta = await getOptimizedAmandaResponse({
        content: item.msg,
        userText: item.msg,
        lead: makeFreshLead(),
        context: { source: 'whatsapp-inbound', stage: 'novo', isReplay: true },
        messageId: `site-master-${Date.now()}-${i}`,
      });
      
      resultados.push({ ...item, respostaAmanda: resposta?.text || resposta, status: 'ok' });
      console.log('✅');
    } catch (err) {
      resultados.push({ ...item, respostaAmanda: `[ERRO: ${err.message}]`, status: 'erro' });
      console.log('❌');
    }
    
    await new Promise(r => setTimeout(r, 100));
  }

  // Lê conteúdo atual se existir
  let conteudoAtual = '';
  if (fs.existsSync(MASTER_FILE)) {
    conteudoAtual = fs.readFileSync(MASTER_FILE, 'utf-8');
  }

  // Cria nova seção
  const novaSecao = `

---

## 🔄 EXECUÇÃO: ${new Date().toLocaleString('pt-BR')}

**Total testado nesta rodada:** ${resultados.length} mensagens

| # | Página | Intenção | Status |
|---|--------|----------|--------|
${resultados.map((r, i) => `| ${i + 1} | ${r.pagina} | ${r.intencao} | ${r.status === 'ok' ? '✅' : '❌'} |`).join('\n')}

### Detalhes das Conversas

${resultados.map((r, i) => `
#### ${i + 1}. ${r.pagina} — ${r.intencao}

**👤 Lead (mensagem do site):**
\`\`\`
${r.msg}
\`\`\`

**🤖 Amanda respondeu:**
\`\`\`
${r.respostaAmanda}
\`\`\`

**✅ Análise:** [ ] Aprovada | [ ] Precisa ajuste

---
`).join('')}

`;

  // Se for primeira execução, cria header
  if (!conteudoAtual) {
    const header = `# 🌐 RELATÓRIO MASTER — Testes Site Fono Inova

**Arquivo acumulativo** — Todas as execuções são adicionadas abaixo  
**Total de páginas cobertas:** 15  
**Mensagens por execução:** ${MENSAGENS_SITE.length}

> 💡 Este arquivo é atualizado automaticamente cada vez que você roda o teste.
> Compare as execuções para ver evolução da Amanda.

`;
    fs.writeFileSync(MASTER_FILE, header + novaSecao);
  } else {
    // Append no final
    fs.writeFileSync(MASTER_FILE, conteudoAtual + novaSecao);
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log('✅ MASTER ATUALIZADO!');
  console.log(`${'═'.repeat(64)}`);
  console.log(`\n📄 Arquivo: tests-amanda-ouro/RELATORIO-MASTER-SITE-FONO-INOVA.md`);
  console.log(`📊 Total de execuções no arquivo: ${(conteudoAtual.match(/🔄 EXECUÇÃO:/g) || []).length + 1}`);
  console.log(`\n💡 Dica: Abra o arquivo e compare execuções para ver melhorias!\n`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('💥 ERRO:', err);
  process.exit(1);
});

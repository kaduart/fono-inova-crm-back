/**
 * Relatório de conversas presas — cliente esperando resposta da Amanda
 *
 * Critérios de "presa":
 *   1. lastDirection === 'inbound'  (última msg foi do cliente, Amanda não respondeu)
 *   2. OU unreadCount > 0          (tem msgs não lidas mesmo que Amanda tenha respondido depois)
 *
 * Saída: relatório no terminal + arquivo relatorio-presas-YYYY-MM-DD.json
 */
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  // Modelos inline para não depender de imports com side effects
  const ChatProjection = mongoose.model('ChatProjection', new mongoose.Schema({
    leadId: mongoose.Schema.Types.ObjectId,
    phone: String,
    contactName: String,
    lastMessage: String,
    lastMessageAt: Date,
    lastDirection: String,
    unreadCount: Number,
  }, { collection: 'chat_projections' }));

  const Message = mongoose.model('Message', new mongoose.Schema({
    lead: mongoose.Schema.Types.ObjectId,
    direction: String,
    content: String,
    timestamp: Date,
    from: String,
    status: String,
    needs_human_review: Boolean,
  }, { collection: 'messages' }));

  // 1. Busca conversas presas
  const presas = await ChatProjection.find({
    $or: [
      { lastDirection: 'inbound' },
      { unreadCount: { $gt: 0 } },
    ]
  }).sort({ lastMessageAt: 1 }).lean(); // mais antigas primeiro

  if (presas.length === 0) {
    console.log('✅ Nenhuma conversa presa encontrada.');
    await mongoose.disconnect();
    return;
  }

  // 2. Para cada conversa presa, busca a última msg inbound real
  const leadIds = presas.map(p => p.leadId);

  const ultimasMsgsInbound = await Message.aggregate([
    { $match: { lead: { $in: leadIds }, direction: 'inbound' } },
    { $sort: { timestamp: -1 } },
    { $group: {
      _id: '$lead',
      content: { $first: '$content' },
      timestamp: { $first: '$timestamp' },
      from: { $first: '$from' },
      needs_human_review: { $first: '$needs_human_review' },
    }},
  ]);

  const inboundMap = new Map(ultimasMsgsInbound.map(m => [String(m._id), m]));

  // 3. Monta relatório
  const agora = new Date();

  const relatorio = presas.map(p => {
    const inbound = inboundMap.get(String(p.leadId));
    const esperandoDesde = inbound?.timestamp || p.lastMessageAt;
    const minutosEsperando = esperandoDesde
      ? Math.floor((agora - new Date(esperandoDesde)) / 60000)
      : null;

    return {
      leadId: String(p.leadId),
      telefone: p.phone || '(sem telefone)',
      nome: p.contactName || null,
      ultimaMsgCliente: inbound?.content?.slice(0, 120) || p.lastMessage?.slice(0, 120),
      esperandoDesde: esperandoDesde ? new Date(esperandoDesde).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?',
      minutosAguardando: minutosEsperando,
      aguardandoLabel: formatAguardando(minutosEsperando),
      unreadCount: p.unreadCount,
      precisaHumano: inbound?.needs_human_review || false,
    };
  });

  // Ordena: mais antigos primeiro
  relatorio.sort((a, b) => (b.minutosAguardando || 0) - (a.minutosAguardando || 0));

  // 4. Imprime no terminal
  const separador = '─'.repeat(80);
  console.log('\n' + separador);
  console.log(`📋 RELATÓRIO DE CONVERSAS PRESAS — ${agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log(separador);
  console.log(`Total: ${relatorio.length} conversa(s) aguardando resposta\n`);

  let precisamHumano = 0;
  let maisDeUmaDia = 0;

  relatorio.forEach((r, i) => {
    if (r.precisaHumano) precisamHumano++;
    if (r.minutosAguardando > 1440) maisDeUmaDia++;

    const urgencia = r.minutosAguardando > 1440 ? '🔴' : r.minutosAguardando > 60 ? '🟡' : '🟢';
    const humano = r.precisaHumano ? ' 🙋 HUMANO' : '';

    console.log(`${urgencia}${humano} [${i + 1}] ${r.telefone} ${r.nome ? `(${r.nome})` : ''}`);
    console.log(`   ⏱  Aguardando: ${r.aguardandoLabel} | Não lidas: ${r.unreadCount}`);
    console.log(`   💬 "${r.ultimaMsgCliente || '(sem conteúdo)'}"`);
    console.log(`   📅 Desde: ${r.esperandoDesde}`);
    console.log();
  });

  console.log(separador);
  console.log(`🔴 Mais de 24h: ${maisDeUmaDia}`);
  console.log(`🙋 Precisam de humano: ${precisamHumano}`);
  console.log(`📊 Total: ${relatorio.length}`);
  console.log(separador + '\n');

  // 5. Salva JSON
  const nomeArquivo = `relatorio-presas-${agora.toISOString().slice(0, 10)}.json`;
  const caminhoArquivo = path.join(__dirname, nomeArquivo);
  fs.writeFileSync(caminhoArquivo, JSON.stringify(relatorio, null, 2), 'utf8');
  console.log(`💾 Salvo em: ${caminhoArquivo}\n`);

  await mongoose.disconnect();
}

function formatAguardando(minutos) {
  if (minutos === null) return '?';
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const min = minutos % 60;
  if (horas < 24) return `${horas}h${min > 0 ? ` ${min}min` : ''}`;
  const dias = Math.floor(horas / 24);
  const horasResto = horas % 24;
  return `${dias}d ${horasResto}h`;
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const backupsDir = join(__dirname, '../../backups-mongo');
  const files = await fs.readdir(backupsDir);
  const reportFiles = files
    .filter(f => f.startsWith('orphan-payments-report-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (reportFiles.length === 0) {
    console.error('❌ Nenhum relatório de orphan payments encontrado em backups-mongo/');
    process.exit(1);
  }

  const latestReport = join(backupsDir, reportFiles[0]);
  console.log(`📄 Lendo relatório: ${reportFiles[0]}\n`);

  const data = JSON.parse(await fs.readFile(latestReport, 'utf8'));
  const investigate = data.investigate || [];

  if (investigate.length === 0) {
    console.log('✅ Nenhum payment na categoria "investigar".');
    process.exit(0);
  }

  const sum = (arr) => arr.reduce((s, p) => s + (p.amount || 0), 0);
  const countBy = (key) => investigate.reduce((acc, p) => {
    const val = p[key] || 'null';
    acc[val] = acc[val] || { count: 0, total: 0, paidCount: 0, paidTotal: 0 };
    acc[val].count++;
    acc[val].total += (p.amount || 0);
    if (p.status === 'paid') {
      acc[val].paidCount++;
      acc[val].paidTotal += (p.amount || 0);
    }
    return acc;
  }, {});

  const printGroup = (title, groups) => {
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`  ${title}`);
    console.log(`══════════════════════════════════════════════════════════`);
    const sorted = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
    for (const [key, val] of sorted) {
      console.log(`  ${key.padEnd(25)} | ${String(val.count).padStart(3)} | R$ ${val.total.toFixed(2).padStart(10)} | paid: ${val.paidCount} (R$ ${val.paidTotal.toFixed(2)})`);
    }
  };

  // Situações de referência
  const situations = investigate.reduce((acc, p) => {
    const key = [
      p.patientExists ? 'patient-exists' : 'patient-missing',
      p.appointmentExists ? 'appointment-exists' : 'appointment-missing',
      p.sessionExists ? 'session-exists' : 'session-missing',
      p.packageExists ? 'package-exists' : 'package-missing'
    ].join(' + ');

    acc[key] = acc[key] || { count: 0, total: 0, paidCount: 0, paidTotal: 0 };
    acc[key].count++;
    acc[key].total += (p.amount || 0);
    if (p.status === 'paid') {
      acc[key].paidCount++;
      acc[key].paidTotal += (p.amount || 0);
    }
    return acc;
  }, {});

  printGroup('SITUAÇÃO DAS REFERÊNCIAS', situations);
  printGroup('POR STATUS', countBy('status'));
  printGroup('POR KIND', countBy('kind'));
  printGroup('POR MÉTODO DE PAGAMENTO', countBy('paymentMethod'));
  printGroup('POR BILLING TYPE', countBy('billingType'));

  // Por período (mês/ano de createdAt)
  const byPeriod = investigate.reduce((acc, p) => {
    const d = p.createdAt ? new Date(p.createdAt) : null;
    const key = d ? `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : 'sem-data';
    acc[key] = acc[key] || { count: 0, total: 0, paidCount: 0, paidTotal: 0 };
    acc[key].count++;
    acc[key].total += (p.amount || 0);
    if (p.status === 'paid') {
      acc[key].paidCount++;
      acc[key].paidTotal += (p.amount || 0);
    }
    return acc;
  }, {});
  printGroup('POR PERÍODO (mês/ano)', byPeriod);

  // Top pagamentos paid para investigação manual
  const paidToReview = investigate
    .filter(p => p.status === 'paid')
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 20);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  TOP 20 PAYMENTS PAID PARA INVESTIGAR');
  console.log('══════════════════════════════════════════════════════════');
  for (const p of paidToReview) {
    console.log(`  ${p._id} | R$ ${String(p.amount).padStart(7)} | ${String(p.kind).padEnd(20)} | ${String(p.paymentMethod).padEnd(15)} | patient=${p.patientExists} appt=${p.appointmentExists} session=${p.sessionExists} pkg=${p.packageExists} | ${p.patientName || '-'} | ${p.createdAt}`);
  }

  // Salvar análise em JSON
  const analysisPath = join(backupsDir, `investigate-payments-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(analysisPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceReport: reportFiles[0],
    totalInvestigate: investigate.length,
    totalValue: sum(investigate),
    paidValue: sum(investigate.filter(p => p.status === 'paid')),
    groups: {
      situation: situations,
      status: countBy('status'),
      kind: countBy('kind'),
      paymentMethod: countBy('paymentMethod'),
      billingType: countBy('billingType'),
      period: byPeriod
    },
    topPaidToReview: paidToReview
  }, null, 2));
  console.log(`\n💾 Análise salva em: ${analysisPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const pkgs = await db.collection('packages').find(
    { status: { $in: ['active', 'confirmed'] } },
    { projection: { _id: 1, totalSessions: 1, sessionsDone: 1, sessionsUsed: 1 } }
).toArray();

const views = await db.collection('packages_view').find(
    { status: 'active' },
    { projection: { _id: 1, packageId: 1, sessionsRemaining: 1 } }
).toArray();
const viewByPkgId = Object.fromEntries(views.map(v => [(v.packageId || v._id).toString(), v]));

const semView = pkgs.filter(p => !viewByPkgId[p._id.toString()]);

let divergentes = [];
for (const p of pkgs) {
    const v = viewByPkgId[p._id.toString()];
    if (!v) continue;
    const done = p.sessionsDone || p.sessionsUsed || 0;
    const remaining_pkg = (p.totalSessions || 0) - done;
    const remaining_view = v.sessionsRemaining || 0;
    if (remaining_pkg !== remaining_view) {
        divergentes.push({ id: p._id.toString().slice(-6), pkg: remaining_pkg, view: remaining_view, diff: remaining_pkg - remaining_view });
    }
}

const totalPkgSessoes = pkgs.reduce((s,p) => s + (p.totalSessions||0) - (p.sessionsDone||p.sessionsUsed||0), 0);
const totalViewSessoes = views.reduce((s,v) => s + (v.sessionsRemaining||0), 0);
const totalDiffDiverg = divergentes.reduce((s,d) => s+d.diff, 0);
const totalDiffSemView = semView.reduce((p, pkg) => p + (pkg.totalSessions||0) - (pkg.sessionsDone||pkg.sessionsUsed||0), 0);

console.log('\nDiagnóstico PackagesView vs Package');
console.log('─────────────────────────────────────────');
console.log(`Package.active:         ${pkgs.length} pacotes | ${totalPkgSessoes} sessões`);
console.log(`PackagesView.active:    ${views.length} pacotes | ${totalViewSessoes} sessões`);
console.log(`Diferença total:        ${totalPkgSessoes - totalViewSessoes} sessões`);
console.log('─────────────────────────────────────────');
console.log(`Pacotes sem view:       ${semView.length} (${totalDiffSemView} sessões não representadas)`);
console.log(`Pacotes com view stale: ${divergentes.length} (${totalDiffDiverg} sessões divergentes)`);
if (divergentes.length > 0) {
    divergentes.slice(0,5).forEach(d =>
        console.log(`  ...${d.id} | package:${d.pkg} view:${d.view} diff:+${d.diff}`)
    );
}
console.log('─────────────────────────────────────────');
console.log('Causa raiz provável:');
if (semView.length > 0) console.log(`  • ${semView.length} pacotes ativos nunca tiveram PackagesView criado`);
if (divergentes.length > 0) console.log(`  • ${divergentes.length} views com sessionsRemaining desatualizado (sync pendente)`);

await mongoose.disconnect();

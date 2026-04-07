import mongoose from 'mongoose';
import moment from 'moment-timezone';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/crm_ama';
const TIMEZONE = 'America/Sao_Paulo';

async function analyze() {
    await mongoose.connect(MONGODB_URI);
    console.log('🔌 MongoDB conectado\n');

    // Período de Abril 2026
    const startOfApril = moment.tz([2026, 3], TIMEZONE).startOf('month').toDate();
    const endOfApril = moment.tz([2026, 3], TIMEZONE).endOf('month').toDate();

    console.log('📅 Período:', startOfApril.toISOString(), 'até', endOfApril.toISOString());

    // Buscar atendimentos de convênio realizados em abril
    const appointments = await mongoose.connection.collection('appointments').find({
        date: { $gte: startOfApril, $lte: endOfApril },
        billingType: 'convenio',
        status: 'completed',
        isDeleted: { $ne: true }
    }).toArray();

    console.log(`\n🏥 ATENDIMENTOS DE CONVÊNIO REALIZADOS: ${appointments.length}`);
    
    if (appointments.length === 0) {
        console.log('⚠️ Nenhum atendimento de convênio encontrado em abril/2026');
        
        // Verificar se tem outros status
        const allConvenio = await mongoose.connection.collection('appointments').find({
            date: { $gte: startOfApril, $lte: endOfApril },
            billingType: 'convenio',
            isDeleted: { $ne: true }
        }).toArray();
        
        console.log('\n📊 Todos os atendimentos convênio por status:');
        const byStatus = {};
        for (const a of allConvenio) {
            byStatus[a.status] = (byStatus[a.status] || 0) + 1;
        }
        console.log(byStatus);
        
        // Ver outros meses
        console.log('\n📅 Atendimentos convênio por mês:');
        const allConv = await mongoose.connection.collection('appointments').find({
            billingType: 'convenio',
            isDeleted: { $ne: true }
        }).toArray();
        
        const byMonth = {};
        for (const a of allConv) {
            const m = moment(a.date).format('YYYY-MM');
            byMonth[m] = (byMonth[m] || 0) + 1;
        }
        console.log(byMonth);
        
    } else {
        const totalValue = appointments.reduce((sum, a) => sum + (a.value || 0), 0);
        console.log(`💰 Valor total: R$ ${totalValue.toFixed(2)}`);
        
        // Agrupar por dia
        const byDay = {};
        for (const a of appointments) {
            const day = moment(a.date).format('YYYY-MM-DD');
            if (!byDay[day]) byDay[day] = { count: 0, value: 0 };
            byDay[day].count++;
            byDay[day].value += (a.value || 0);
        }
        
        console.log('\n📆 Por dia:');
        Object.entries(byDay).sort().forEach(([day, data]) => {
            console.log(`  ${day}: ${data.count} atendimentos - R$ ${data.value.toFixed(2)}`);
        });

        // Verificar se existe Payment para esses atendimentos
        const appointmentIds = appointments.map(a => a._id.toString());
        const payments = await mongoose.connection.collection('payments').find({
            appointmentId: { $in: appointmentIds }
        }).toArray();
        
        console.log(`\n💳 Payments encontrados: ${payments.length}`);
        console.log(`   → ${appointments.length - payments.length} atendimentos SEM payment`);
        
        // Verificar status dos payments
        const paymentsByStatus = {};
        for (const p of payments) {
            paymentsByStatus[p.status] = (paymentsByStatus[p.status] || 0) + 1;
        }
        console.log('\n📊 Payments por status:', paymentsByStatus);
    }

    await mongoose.disconnect();
}

analyze().catch(e => {
    console.error('Erro:', e);
    process.exit(1);
});

import moment from 'moment-timezone';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

export async function createNextPackageFromPrevious(previousPackage, initialAmount, options = {}) {
    const {
        session,
        paymentMethod = 'dinheiro',
        serviceType = 'package_session',
        paymentDate = new Date(),
        notes = 'Pagamento adiantado para novo pacote',
    } = options;

    // 1️⃣ Determinar data e hora de início
    const lastSession = previousPackage.sessions?.[previousPackage.sessions.length - 1];
    const startDate = lastSession
        ? moment(lastSession.date).add(7, 'days').toDate()
        : new Date();

    const startTime = lastSession?.time || '08:00'; // fallback

    // 2️⃣ Replicar parâmetros
    const totalSessions = previousPackage.totalSessions || 4;
    const sessionValue = previousPackage.sessionValue || initialAmount / totalSessions;
    const totalValue = totalSessions * sessionValue;

    const totalPaid = initialAmount;
    const balance = Math.max(totalValue - totalPaid, 0);
    const financialStatus =
        totalPaid >= totalValue
            ? 'paid'
            : totalPaid > 0
                ? 'partially_paid'
                : 'pending';

    // 3️⃣ Criar novo pacote
    const newPackage = await Package.create(
        [
            {
                patient: previousPackage.patient,
                doctor: previousPackage.doctor,
                serviceType: previousPackage.serviceType,
                totalSessions,
                sessionValue,
                totalValue,
                totalPaid,
                balance,
                financialStatus,
                startDate,
            },
        ],
        { session }
    );

    // 4️⃣ Criar sessões futuras automáticas (1/semana, mesmo horário)
    const newSessions = [];
    for (let i = 0; i < totalSessions; i++) {
        const sessionDate = moment(startDate).add(i * 7, 'days').toDate();
        newSessions.push({
            patient: previousPackage.patient,
            doctor: previousPackage.doctor,
            package: newPackage[0]._id,
            date: sessionDate,
            time: startTime,
            status: 'scheduled',           // sessão ainda não confirmada
            paymentStatus: 'paid',         // pois foi pré-paga
            operationalStatus: 'scheduled' // mantém neutro
        });
    }

    const createdSessions = await Session.insertMany(newSessions, { session });

    // 5️⃣ Criar pagamento vinculado ao novo pacote
    const newPayment = await Payment.create(
        [
            {
                patient: previousPackage.patient,
                doctor: previousPackage.doctor,
                package: newPackage[0]._id,
                amount: initialAmount,
                paymentMethod,
                serviceType,
                status: 'paid',
                notes,
                paymentDate,
            },
        ],
        { session }
    );

    console.log(`
🧾 Novo pacote criado automaticamente:
🧍 Paciente: ${previousPackage.patient}
👩‍⚕️ Doutor: ${previousPackage.doctor}
🗓️ Início: ${moment(startDate).format('DD/MM/YYYY HH:mm')}
💰 Total: R$${totalValue.toFixed(2)} | Pago: R$${initialAmount.toFixed(2)}
💼 Status: ${financialStatus}
📅 Sessões: ${createdSessions.length}
💵 Pagamento ID: ${newPayment[0]._id}
`);

    return {
        newPackage: newPackage[0],
        createdSessions,
        newPayment: newPayment[0],
    };
}

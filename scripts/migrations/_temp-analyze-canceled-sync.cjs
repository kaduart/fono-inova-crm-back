const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Appointment = mongoose.connection.db.collection('appointments');
  const Payment = mongoose.connection.db.collection('payments');
  const Session = mongoose.connection.db.collection('sessions');

  const engineIds = require('/tmp/finance-health-v5.json').issues
    .filter(i => i.category === 'GHOST_PAYMENT_STATUS')
    .map(i => new mongoose.Types.ObjectId(i.appointmentId));

  const appts = await Appointment.find({ _id: { $in: engineIds } })
    .project({
      _id: 1, patient: 1, date: 1, operationalStatus: 1, clinicalStatus: 1,
      paymentStatus: 1, isPaid: 1, billingType: 1, paymentMethod: 1, paymentOrigin: 1,
      payment: 1, package: 1, session: 1, sessions: 1, serviceType: 1,
      createdAt: 1, updatedAt: 1, canceledAt: 1, cancelReason: 1, history: 1
    }).toArray();

  const report = [];
  for (const a of appts) {
    const payments = await Payment.find({
      $or: [{ appointment: a._id }, { appointmentId: a._id.toString() }]
    }).project({ status: 1, amount: 1, kind: 1, billingType: 1, canceledAt: 1, canceledReason: 1 }).toArray();

    const session = a.session ? await Session.findOne({ _id: a.session }, { projection: { status: 1, paymentStatus: 1, isPaid: 1 } }) : null;

    report.push({
      appointmentId: a._id.toString(),
      operationalStatus: a.operationalStatus,
      paymentStatus: a.paymentStatus,
      isPaid: a.isPaid,
      billingType: a.billingType,
      paymentMethod: a.paymentMethod,
      serviceType: a.serviceType,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      canceledAt: a.canceledAt,
      cancelReason: a.cancelReason,
      embeddedPaymentStatus: a.payment?.status,
      embeddedPaymentId: a.payment?._id?.toString?.(),
      payments: payments.map(p => ({ status: p.status, amount: p.amount, kind: p.kind, billingType: p.billingType, canceledReason: p.canceledReason })),
      session: session ? { status: session.status, paymentStatus: session.paymentStatus, isPaid: session.isPaid } : null,
      historyActions: (a.history || []).slice(-3).map(h => h.action)
    });
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
})();

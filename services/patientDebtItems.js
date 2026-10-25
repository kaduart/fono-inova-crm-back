import { LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS } from '../constants/financial.js';
const id = x => String(x?._id ?? x ?? ''), round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const protectedBilling = x => ['convenio', 'insurance', 'liminar'].includes(x?.billingType) || !!x?.insuranceGuide || !!x?.liminarContract;
const canceled = x => ['canceled', 'cancelled', 'force_cancelled', 'refunded'].some(status => x?.status === status || x?.operationalStatus === status);
const paidSession = x => x?.isPaid === true || ['paid', 'package_paid', 'recognized'].includes(x?.paymentStatus);
const coveredPayment = p => p.isFromPackage || LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS.includes(p.kind);
const recoveryReview = (a, s) => {
    const note = [a?.visualFlag === 'blocked' && a.balanceDescription, s?.visualFlag === 'blocked' && s.notes]
        .find(value => typeof value === 'string' && value.startsWith('RECOVERY_REVIEW:'));
    return note ? note.slice('RECOVERY_REVIEW:'.length).trim() : null;
};
// This function only constructs a read model: no events, updates or generated Payments.
const isSettledDebitFor = (t, sid, aid) => t.type === 'debit' && !t.isDeleted
    && (t.isPaid || t.settledByPackageId || Number(t.paidAmount) >= Number(t.amount))
    && ((id(t.sessionId) && id(t.sessionId) === sid) || (id(t.appointmentId) && id(t.appointmentId) === aid));
export function consolidatePatientDebt({ payments = [], sessions = [], appointments = [], packages = [], transactions = [], pendingPayments = [] }) {
    const appts = new Map(appointments.map(a => [id(a), a])), pkgs = new Map(packages.map(p => [id(p), p]));
    const bySession = new Map(), byAppointment = new Map();
    const index = (map, key, p) => { if (key)
        map.set(key, [...(map.get(key) || []), p]); };
    for (const p of payments) {
        for (const sid of [p.session, ...(p.sessions || []), ...(p.advanceSessions || [])])
            index(bySession, id(sid), p);
        index(byAppointment, id(p.appointment || p.appointmentId), p);
    }
    const relation = (sessionId, appointmentId) => [...new Map([...(bySession.get(id(sessionId)) || []), ...(byAppointment.get(id(appointmentId)) || [])].map(p => [id(p), p])).values()];
    const items = [], coveredSessions = new Set(), coveredAppointments = new Set();
    const cover = (s, a) => { if (id(s))
        coveredSessions.add(id(s)); if (id(a))
        coveredAppointments.add(id(a)); };
    const dto = (x, source, amount, a, extra = {}) => ({ id: id(x), source, amount, status: 'pending', createdAt: x.createdAt || x.transactionDate || x.date || null, paidAt: null, description: x.description || null, appointment: a ? { id: id(a), date: a.date, time: a.time, sessionValue: a.sessionValue } : null, packageId: id(x.package || a?.package) || null, packageName: (x.package || a?.package) ? `Pacote ${a?.specialty || x.sessionType || ''}`.trim() : null, specialty: a?.specialty || x.specialty || x.sessionType || null, canSettle: source === 'payment', countInDebt: true, ...extra });
    const seenPayments = new Set();
    for (const p of pendingPayments) {
        if (seenPayments.has(id(p)) || coveredPayment(p))
            continue;
        seenPayments.add(id(p));
        const a = appts.get(id(p.appointment || p.appointmentId)) || (p.appointment && typeof p.appointment === 'object' && p.appointment.operationalStatus ? p.appointment : null);
        const sid = id(p.session), aid = id(a) || id(p.appointmentId);
        const linked = relation(sid, aid).filter(x => id(x) !== id(p));
        const session = sessions.find(x => id(x) === sid || id(x.appointmentId) === aid);
        const pkg = pkgs.get(id(p.package || session?.package || a?.package));
        // The canonical Payment wins over ledger/session shadows. Conflicts are visible,
        // but cannot become another charge. A paid deposit alone does not settle a balance.
        let reason = null;
        if (recoveryReview(a, session))
            reason = recoveryReview(a, session);
        else if (!a && (p.appointmentId || p.appointment))
            reason = 'Agendamento vinculado não localizado; conferir origem';
        else if (canceled(a) || canceled(session))
            reason = 'Cancelamento localizado; conferir pagamento';
        else if (paidSession(session) || paidSession(a))
            reason = 'Atendimento marcado como quitado; conferir pagamento';
        else if (linked.some(x => x.status === 'paid' && x.paymentRole !== 'deposit'))
            reason = 'Pagamento já localizado; conferir duplicidade';
        else if (linked.some(canceled))
            reason = 'Cancelamento ou estorno vinculado; conferir pagamento';
        else if (transactions.some(t => isSettledDebitFor(t, sid, aid)))
            reason = 'Débito vinculado já quitado; conferir pagamento';
        else if (linked.some(x => x.status === 'pending' &&
            (x.paymentRole || 'standard') === (p.paymentRole || 'standard') && !coveredPayment(x)))
            reason = 'Mais de um pagamento pendente para a mesma obrigação';
        else if (linked.some(x => coveredPayment(x) || x.status === 'converted_to_package') || pkg?.model === 'prepaid')
            reason = 'Cobertura de pacote localizada; conferir pagamento';
        else if (protectedBilling(a) || protectedBilling(session))
            reason = 'Origem convênio ou liminar; conferir responsabilidade financeira';
        items.push(dto(p, 'payment', Number(p.amount), a, { requiresReview: !!reason, reviewReason: reason, countInDebt: !reason, canSettle: !reason }));
        cover(p.session, a?._id || p.appointment || p.appointmentId);
    }
    const groups = new Map();
    for (const t of transactions) {
        if (t.type !== 'debit' || t.isDeleted || t.isPaid || t.settledByPackageId)
            continue;
        const amount = round(Number(t.amount) - Number(t.paidAmount || 0));
        if (!(amount > 0))
            continue;
        const session = sessions.find(s => id(s) === id(t.sessionId));
        const appointmentId = t.appointmentId || session?.appointmentId;
        const key = appointmentId ? 'a:' + id(appointmentId) : t.sessionId ? 's:' + id(t.sessionId) : 't:' + id(t);
        groups.set(key, [...(groups.get(key) || []), { t, amount }]);
    }
    for (const group of groups.values()) {
        const { t, amount } = group[0], sid = id(t.sessionId), aid = id(t.appointmentId || sessions.find(s => id(s) === sid)?.appointmentId);
        if (coveredSessions.has(sid) || coveredAppointments.has(aid))
            continue;
        const related = relation(sid, aid), a = appts.get(aid), s = sessions.find(x => id(x) === sid);
        let reason = null;
        if (recoveryReview(a, s))
            reason = recoveryReview(a, s);
        else if (related.some(p => p.status === 'paid'))
            reason = 'Pagamento já localizado; conferir baixa do débito';
        else if (related.some(p => canceled(p)) || canceled(a) || canceled(s))
            reason = 'Cancelamento ou estorno localizado; conferir vínculo do débito';
        else if (paidSession(s) || paidSession(a))
            reason = 'Atendimento marcado como quitado; conferir débito';
        else if (pkgs.get(id(s?.package || a?.package))?.model === 'prepaid' || related.some(coveredPayment))
            reason = 'Cobertura de pacote localizada; conferir débito';
        else if (transactions.some(x => !x.isDeleted && ['credit', 'payment'].includes(x.type) && group.some(g => id(x.linkedDebitId) === id(g.t))))
            reason = 'Crédito ou pagamento vinculado; conferir conciliação';
        else if (related.some(p => ['pending', 'partial', 'billed'].includes(p.status)))
            reason = 'Lançamento financeiro relacionado exige conciliação';
        else if (group.some(g => g.amount !== amount))
            reason = 'Lançamentos do mesmo atendimento divergem no valor';
        else if (protectedBilling(a) || protectedBilling(s))
            reason = 'Origem convênio ou liminar; conferir responsabilidade financeira';
        items.push(dto(t, 'balance', amount, a, { canSettle: false, requiresReview: !!reason, reviewReason: reason, countInDebt: !reason, relatedRecordIds: group.map(x => id(x.t)), description: t.description || 'Débito da conta corrente' }));
        cover(sid, aid);
    }
    for (const s of sessions) {
        const sid = id(s), aid = id(s.appointmentId);
        if (s.status !== 'completed' || paidSession(s) || (!['pending', 'unpaid', 'partial', 'pending_balance'].includes(s.paymentStatus) && !recoveryReview(appts.get(aid), s)) || coveredSessions.has(sid) || coveredAppointments.has(aid))
            continue;
        const a = appts.get(aid), pkg = pkgs.get(id(s.package));
        if (protectedBilling(s) || protectedBilling(a) || canceled(a) || canceled(pkg) || pkg?.model === 'prepaid' || ['package_prepaid', 'convenio', 'liminar', 'liminar_credit'].includes(s.paymentMethod))
            continue;
        const related = relation(sid, aid);
        if (transactions.some(t => isSettledDebitFor(t, sid, aid)))
            continue;
        if (related.some(p => ['paid', 'pending', 'partial', 'billed', 'canceled', 'cancelled', 'refunded', 'converted_to_package', 'consumed', 'recognized'].includes(p.status)))
            continue;
        const amount = round(Number(s.sessionValue) - Number(s.partialAmount || 0));
        if (!(amount > 0 && Number.isFinite(amount)))
            continue;
        const reason = recoveryReview(a, s) || (paidSession(a) ? 'Agendamento marcado como quitado; conferir sessão' : (s.package || a?.package) && !pkg ? 'Pacote vinculado não localizado; conferir cobertura' : null);
        items.push(dto(s, 'session', amount, a, { canSettle: false, description: 'Sessão realizada sem lançamento de pagamento', requiresReview: !!reason, reviewReason: reason, countInDebt: !reason }));
        cover(sid, aid);
    }
    return { items, collectibleCount: items.filter(x => x.countInDebt).length, total: round(items.filter(x => x.countInDebt).reduce((a, x) => a + x.amount, 0)), reviewCount: items.filter(x => x.requiresReview).length, reviewAmount: round(items.filter(x => x.requiresReview).reduce((a, x) => a + x.amount, 0)) };
}

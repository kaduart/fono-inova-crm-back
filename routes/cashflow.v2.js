// routes/cashflow.v2.js - CAIXA REAL FECHADO PARA PRODUÇÃO (V2 PURA)
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';
import { logMetric } from '../utils/logMetric.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';

const router = express.Router();

// Cache server-side para CashflowV2 — reduz recálculo na abertura da tela financeira
const _cashflowCache = new Map();
const CASHFLOW_CURRENT_TTL = 30_000;   // 30s para dia atual / range atual
const CASHFLOW_PAST_TTL    = 300_000;  // 5min para períodos passados

function _cashflowCacheKey(date, startDate, endDate, month = '') {
    return `${date || ''}_${startDate || ''}_${endDate || ''}_${month || ''}`;
}

function _getCashflowCached(key, ttl) {
    const entry = _cashflowCache.get(key);
    if (entry && Date.now() - entry.ts < ttl) {
        console.log(`[cashflow.v2] CACHE HIT ${key} (age=${Date.now() - entry.ts}ms ttl=${ttl}ms)`);
        return entry.data;
    }
    return null;
}

function _setCashflowCached(key, data) {
    if (_cashflowCache.size > 50) _cashflowCache.clear();
    _cashflowCache.set(key, { data, ts: Date.now() });
    console.log(`[cashflow.v2] CACHE SET ${key}`);
}

// GET /api/v2/cashflow?date=2026-04-10 OU ?startDate=2026-04-10&endDate=2026-04-16
router.get('/', auth, async (req, res) => {
    const startedAt = Date.now();
    const _timers = {};
    const _tick = (label) => {
        const now = Date.now();
        const prev = _timers[label]?.at || startedAt;
        _timers[label] = { at: now, elapsed: now - prev };
        return _timers[label].elapsed;
    };
    try {
        const { date, startDate, endDate } = req.query;

        let start, end, targetDate;

        if (startDate && endDate) {
            // Range customizado (semana, etc.)
            targetDate = startDate;
            start = moment.tz(startDate, 'America/Sao_Paulo').startOf('day').utc().toDate();
            end = moment.tz(endDate, 'America/Sao_Paulo').endOf('day').utc().toDate();
        } else {
            // Dia único (padrão)
            targetDate = date || moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');
            start = moment.tz(targetDate, 'America/Sao_Paulo').startOf('day').utc().toDate();
            end = moment.tz(targetDate, 'America/Sao_Paulo').endOf('day').utc().toDate();
        }

        const todayStr = moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');
        const cacheKey = _cashflowCacheKey(targetDate, startDate, endDate);
        const isCurrent = (startDate && endDate)
            ? endDate === todayStr
            : targetDate === todayStr;
        const cached = _getCashflowCached(cacheKey, isCurrent ? CASHFLOW_CURRENT_TTL : CASHFLOW_PAST_TTL);
        if (cached) {
            res.set('X-Cache-Hit', 'true');
            return res.json(cached);
        }

        // ============================================================
        // 🎯 CAIXA & PRODUÇÃO — Fonte única de verdade (V2 pura)
        // ============================================================
        const _tCashflowBase = Date.now();
        const [cash, production, convenioAppts] = await Promise.all([
            unifiedFinancialService.calculateCash(start, end).then(r => {
                console.log(`[cashflow.v2] calculateCash = ${Date.now() - _tCashflowBase}ms`);
                return r;
            }),
            unifiedFinancialService.calculateProduction(start, end).then(r => {
                console.log(`[cashflow.v2] calculateProduction = ${Date.now() - _tCashflowBase}ms`);
                return r;
            }),
            Appointment.find({
                date: { $gte: start, $lte: end },
                operationalStatus: 'completed',
                billingType: 'convenio'
            })
                .select('_id time date doctor specialty billingType insuranceProvider insuranceValue sessionValue paymentStatus patient patientName patientInfo serviceType')
                .populate('patient', 'fullName phone')
                .populate('doctor', 'fullName specialty')
                .lean()
        ]);

        // ============================================================
        // 🎯 BUSCA DESPESAS DO PERÍODO
        // ============================================================
        const _tExpenses = Date.now();
        const expenseQuery = {
            status: { $nin: ['canceled', 'cancelado'] }
        };
        if (startDate && endDate) {
            expenseQuery.date = { $gte: startDate, $lte: endDate };
        } else {
            expenseQuery.date = targetDate;
        }
        const expenses = await Expense.find(expenseQuery).lean();
        console.log(`[cashflow.v2] expenses.find = ${Date.now() - _tExpenses}ms (${expenses.length} docs)`);

        // ============================================================
        // 🔧 DADOS AUXILIARES PARA EXIBIÇÃO (transações detalhadas)
        // ============================================================
        const _tAuxMaps = Date.now();
        const appointmentIds = cash.payments.map(p => p.appointment?.toString()).filter(Boolean);
        const sessionApptIds = production.sessions.map(s => s.appointmentId?.toString()).filter(Boolean);
        const allApptIds = Array.from(new Set([...appointmentIds, ...sessionApptIds]));

        const [appointmentsMap, doctorsMap, patientMap] = await Promise.all([
            allApptIds.length > 0
                ? Appointment.find({ _id: { $in: allApptIds } })
                    .select('_id time date doctor specialty operationalStatus billingType insuranceProvider serviceType package patient patientName patientInfo paymentStatus paymentMethod paymentForms notes cancelReason')
                    .populate('patient', 'fullName phone')
                    .populate('doctor', 'fullName specialty')
                    .populate('package', 'paymentType sessionValue totalValue totalSessions model')
                    .lean()
                    .then(list => new Map(list.map(a => [a._id.toString(), a])))
                : new Map(),
            (async () => {
                const _tDoctors = Date.now();
                const doctorIds = Array.from(new Set(production.sessions.map(s => s.doctor?.toString()).filter(Boolean)));
                if (doctorIds.length === 0) return new Map();
                const docs = await (await import('../models/Doctor.js')).default.find({ _id: { $in: doctorIds } }).select('_id fullName specialty').lean();
                console.log(`[cashflow.v2] doctorsMap = ${Date.now() - _tDoctors}ms (${docs.length} docs)`);
                return new Map(docs.map(d => [d._id.toString(), d]));
            })(),
            (async () => {
                const _tPatients = Date.now();
                const patientIds = Array.from(new Set(production.sessions.map(s => s.patient?.toString()).filter(Boolean)));
                if (patientIds.length === 0) return new Map();
                const pts = await (await import('../models/Patient.js')).default.find({ _id: { $in: patientIds } }).select('_id fullName phone').lean();
                console.log(`[cashflow.v2] patientMap = ${Date.now() - _tPatients}ms (${pts.length} docs)`);
                return new Map(pts.map(p => [p._id.toString(), p]));
            })()
        ]);
        console.log(`[cashflow.v2] auxMaps = ${Date.now() - _tAuxMaps}ms (appts=${allApptIds.length})`);

        // sessionId → appointmentId — fallback para payments sem p.appointment direto
        const sessionToApptIdMap = new Map(
            production.sessions
                .filter(s => s._id && s.appointmentId)
                .map(s => [s._id.toString(), s.appointmentId.toString()])
        );

        // appointmentId → Payment — para buscar splitMethods em transacoesProducao
        const paymentByApptId = new Map(
            cash.payments
                .filter(p => p.appointment)
                .map(p => [(p.appointment?._id || p.appointment).toString(), p])
        );

        // patientId → serviceType — via sessions de produção (não depende de populate)
        const patientIdToServiceType = new Map();
        for (const s of production.sessions) {
            if (!s.patient || !s.appointmentId) continue;
            const appt = appointmentsMap.get(s.appointmentId.toString());
            if (appt?.serviceType) {
                patientIdToServiceType.set(s.patient.toString(), appt.serviceType);
            }
        }

        // ============================================================
        // 🎯 COMPARATIVOS: ONTEM E MÊS
        // ============================================================
        const _tComparativos = Date.now();
        const yesterdayStart = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').startOf('day').utc().toDate();
        const yesterdayEnd = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').endOf('day').utc().toDate();

        const _tYesterdayCash = Date.now();
        const yesterdayCash = await unifiedFinancialService.calculateCash(yesterdayStart, yesterdayEnd);
        console.log(`[cashflow.v2] yesterday.calculateCash = ${Date.now() - _tYesterdayCash}ms`);
        // 🎯 O caixa de ontem deve usar os MESMOS filtros do caixa de hoje
        // Busca appointments/sessions de ontem para aplicar filtros consistentes
        const yesterdayApptIds = yesterdayCash.payments.map(p => p.appointment?.toString()).filter(Boolean);
        const yesterdaySessions = await Session.find({
            date: { $gte: yesterdayStart, $lte: yesterdayEnd }
        }).select('_id appointmentId package').lean();
        const yesterdaySessionApptIds = yesterdaySessions.map(s => s.appointmentId?.toString()).filter(Boolean);
        const yesterdayAllApptIds = Array.from(new Set([...yesterdayApptIds, ...yesterdaySessionApptIds]));
        const yesterdayAppointmentsMap = yesterdayAllApptIds.length > 0
            ? await Appointment.find({ _id: { $in: yesterdayAllApptIds } })
                .select('_id time doctor specialty operationalStatus billingType insuranceProvider serviceType package patient patientName patientInfo paymentStatus paymentMethod paymentForms notes cancelReason')
                .populate('patient', 'fullName phone')
                .populate('doctor', 'fullName specialty')
                .populate('package', 'paymentType sessionValue totalValue totalSessions model')
                .lean()
                .then(list => new Map(list.map(a => [a._id.toString(), a])))
            : new Map();
        const yesterdaySessionToApptIdMap = new Map(
            yesterdaySessions.filter(s => s._id && s.appointmentId).map(s => [s._id.toString(), s.appointmentId.toString()])
        );
        const yesterdayPkgSessionPrepaidMap = new Map(
            yesterdaySessions.filter(s => !!s.package).map(s => {
                const apptS = s.appointmentId ? yesterdayAppointmentsMap.get(s.appointmentId.toString()) : null;
                const pt = apptS?.package?.paymentType || apptS?.package?.model;
                return [s._id.toString(), pt === 'full' || pt === 'prepaid'];
            })
        );

        const yesterdayTransacoes = yesterdayCash.payments.map(p => {
            const apptId = p.appointment?.toString() || (p.session ? yesterdaySessionToApptIdMap.get(p.session.toString()) : null);
            const appt = apptId ? yesterdayAppointmentsMap.get(apptId) : null;
            const notes = (p.notes || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            const isLiminarY = p.billingType === 'liminar' || p.paymentMethod === 'liminar_credit';
            const isPackagePayment = !isLiminarY && (notes.includes('pacote') || desc.includes('pacote') || p.type === 'package' || p.serviceType === 'package_session' || p.package || (p.session && yesterdayPkgSessionPrepaidMap.get(p.session.toString()) === true));
            const pkgPaymentTypeY = appt?.package?.paymentType || appt?.package?.model;
            const isPrepaidPackageY = pkgPaymentTypeY === 'full' || pkgPaymentTypeY === 'prepaid';
            // Consumo de pacote PRÉ-PAGO só entra no caixa se a sessão foi concluída; per-session é pagamento real do dia
            if (isPackagePayment && isPrepaidPackageY && appt && appt.operationalStatus !== 'completed') return null;
            if (isPackagePayment) {
                const isCompraHoje = !!p.package;
                const pkgPaymentType = appt?.package?.paymentType || appt?.package?.model;
                const isSessionPrepaid = p.session ? yesterdayPkgSessionPrepaidMap.get(p.session.toString()) : false;
                const isPrepaidConsumo = !isCompraHoje && !!p.session && (pkgPaymentType === 'full' || pkgPaymentType === 'prepaid' || isSessionPrepaid === true);
                if (isPrepaidConsumo) return null;
            }
            return { valor: p.amount };
        }).filter(Boolean);
        const yesterdayTotal = yesterdayTransacoes.reduce((s, t) => s + t.valor, 0);

        const monthStart = moment.tz(targetDate, 'America/Sao_Paulo').startOf('month').utc().toDate();
        const _tMonthCash = Date.now();
        const monthCash = await unifiedFinancialService.calculateCash(monthStart, end);
        console.log(`[cashflow.v2] month.calculateCash = ${Date.now() - _tMonthCash}ms`);
        const totalMes = monthCash.total;
        const dayOfMonth = moment.tz(targetDate, 'America/Sao_Paulo').date();
        const mediaDiariaMes = dayOfMonth > 0 ? totalMes / dayOfMonth : 0;
        const projecaoMes = mediaDiariaMes * 30;
        console.log(`[cashflow.v2] comparativos = ${Date.now() - _tComparativos}ms`);

        // ============================================================
        // ========== TRANSAÇÕES DE CAIXA ==========
        // ============================================================
        const _tTransacoesCaixa = Date.now();
        let qtdPix = 0, qtdDinheiro = 0, qtdCartao = 0;
        const porEspecialidadeCaixa = {};

        // Mapa: sessionId → isPrepaid (true=pré-pago, false=por sessão)
        // Usado para detectar consumo de sessão pré-paga que escapou dos filtros padrão
        const pkgSessionPrepaidMap = new Map(
            production.sessions
                .filter(s => !!s.package)
                .map(s => {
                    const apptS = s.appointmentId ? appointmentsMap.get(s.appointmentId.toString()) : null;
                    const pt = apptS?.package?.paymentType || apptS?.package?.model;
                    return [s._id.toString(), pt === 'full' || pt === 'prepaid'];
                })
        );

        const transacoesCaixa = cash.payments.map(p => {
            const method = (p.paymentMethod || '').toLowerCase();

            // Busca appt: direto → via session → via paciente (payments sem link explícito)
            const apptId = p.appointment?.toString()
                || (p.session ? sessionToApptIdMap.get(p.session.toString()) : null);
            const appt = apptId ? appointmentsMap.get(apptId) : null;
            const patientId = p.patient?._id?.toString() || p.patient?.toString();

            const notes = (p.notes || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            let tipo = 'Particular';
            let servico = 'Sessão';

            // Liminar: crédito judicial consumido — SEMPRE entra no caixa, nunca é filtrado como prepaid
            const isLiminar = p.billingType === 'liminar' || p.paymentMethod === 'liminar_credit';

            const isPackagePayment = !isLiminar && (
                notes.includes('pacote') || desc.includes('pacote') ||
                p.type === 'package' || p.serviceType === 'package_session' ||
                p.package ||
                (p.session && pkgSessionPrepaidMap.get(p.session.toString()) === true)
            );

            // Pré-pagamento: dinheiro recebido antes da sessão → entra no caixa imediatamente (Ana Laura, Henre Gabriel etc.)
            const isPrepagamento = !!(appt?.date && p.financialDate &&
                moment(p.financialDate).tz('America/Sao_Paulo').startOf('day')
                    .isBefore(moment(appt.date).tz('America/Sao_Paulo').startOf('day')));

            const pkgPaymentType = appt?.package?.paymentType || appt?.package?.model;
            const isPrepaidPackage = pkgPaymentType === 'full' || pkgPaymentType === 'prepaid';
            // Consumo de pacote PRÉ-PAGO só entra no caixa se a sessão foi concluída — exceto pré-pagamentos e per-session (pagamento real do dia)
            if (isPackagePayment && isPrepaidPackage && appt && appt.operationalStatus !== 'completed' && !isPrepagamento) {
                return null;
            }

            if (isLiminar) {
                tipo = 'Liminar';
                servico = p.kind === 'liminar_contract_receipt' ? 'Crédito Liminar' : 'Sessão Liminar';
            } else if (isPackagePayment) {
                tipo = 'Pacote';
                // Usa serviceType real do agendamento; fallback para 'Sessão de Pacote'
                const pkgServiceType = appt?.serviceType || p.serviceType || patientIdToServiceType.get(patientId);
                const serviceMap = { 'evaluation': 'Avaliação', 'consultation': 'Consulta', 'session': 'Sessão', 'individual_session': 'Sessão Individual', 'package_session': 'Sessão de Pacote', 'tongue_tie_test': 'Teste da Linguinha', 'neuropsych_evaluation': 'Avaliação Neuropsicológica', 'return': 'Retorno', 'meet': 'Meet', 'alignment': 'Alinhamento' };
                servico = (pkgServiceType && pkgServiceType !== 'package_session')
                    ? (serviceMap[pkgServiceType] || 'Sessão de Pacote')
                    : 'Sessão de Pacote';

                // Pacote pré-pago sendo CONSUMIDO (não é compra do dia nem per-session)
                // → NÃO entra em TRANSAÇÕES (dinheiro entrou quando o pacote foi comprado)
                const isCompraHoje = !!p.package; // pagamento tem ref direta ao pacote = é a compra
                const pkgPaymentType = appt?.package?.paymentType || appt?.package?.model;
                const isSessionPrepaid = p.session ? pkgSessionPrepaidMap.get(p.session.toString()) : false;
                // Consumo pré-pago exige session vinculada — avulso (session: null) é cash real recebido
                const isPrepaidConsumo = !isCompraHoje && !!p.session && (pkgPaymentType === 'full' || pkgPaymentType === 'prepaid' || isSessionPrepaid === true);

                if (isPrepaidConsumo) return null;
            } else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance' || p.billingType === 'convenio') {
                tipo = 'Convênio';
                servico = 'Sessão Convênio';
            } else {
                // 🎯 Fonte de verdade: Appointment > Payment > fallback por paciente
                const serviceType = appt?.serviceType || p.serviceType || patientIdToServiceType.get(patientId);
                if (serviceType) {
                    const serviceMap = { 'evaluation': 'Avaliação', 'consultation': 'Consulta', 'session': 'Sessão', 'individual_session': 'Sessão Individual', 'package_session': 'Sessão de Pacote', 'tongue_tie_test': 'Teste da Linguinha', 'neuropsych_evaluation': 'Avaliação Neuropsicológica', 'return': 'Retorno', 'meet': 'Meet', 'alignment': 'Alinhamento' };
                    servico = serviceMap[serviceType] || 'Sessão';
                }
            }

            // 🎯 Liminar = Transferência Bancária, não conta em nenhum método tradicional
            if (isLiminar) {
                // não incrementa pix/cartao/dinheiro — liminar é categoria própria
            } else if (method.includes('pix')) {
                qtdPix++;
            } else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) {
                qtdCartao++;
            } else if (method.includes('cash') || method.includes('dinheiro')) {
                qtdDinheiro++;
            }

            // 🎯 Fonte de verdade: Appointment > Payment (specialty/sessionType) > 'Outra'
            const esp = appt?.doctor?.specialty || appt?.specialty || appt?.sessionType || p.specialty || p.sessionType || 'Outra';
            if (!porEspecialidadeCaixa[esp]) porEspecialidadeCaixa[esp] = 0;
            porEspecialidadeCaixa[esp] += p.amount;

            let metodo = 'Outros';
            if (isLiminar) {
                metodo = 'Transferência Bancária';
            } else if (tipo === 'Convênio') {
                metodo = 'Convênio';
            } else if (p.splitMethods?.length >= 2) {
                metodo = 'Split';
            } else if (method.includes('pix')) {
                metodo = 'Pix';
            } else if (method.includes('dinheiro') || method.includes('cash')) {
                metodo = 'Dinheiro';
            } else if (method.includes('cartão') || method.includes('cartao') || method.includes('card') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) {
                metodo = 'Cartão';
            }

            return {
                id: p._id,
                paciente: p.patient?.fullName || p.patientName || 'Paciente não identificado',
                valor: p.amount,
                metodo,
                tipo,
                servico,
                especialidade: appt?.doctor?.specialty || appt?.specialty || appt?.sessionType || p.specialty || p.sessionType || 'Outra',
                profissional: appt?.doctor?.fullName || appt?.professionalName || (p.doctor ? doctorsMap.get(p.doctor.toString())?.fullName : null) || '-',
                hora: isLiminar
                    ? moment(p.createdAt || p.financialDate).tz('America/Sao_Paulo').format('HH:mm')
                    : (appt?.time || moment(p.createdAt || p.financialDate).tz('America/Sao_Paulo').format('HH:mm')),
                data: moment(p.financialDate || p.createdAt).format('DD/MM/YYYY'),
                categoria: 'recebido',
                observacao: p.notes || p.description || '-',
                billingType: p.billingType || '-',
                kind: p.kind || '-',
                package: !!p.package || !!appt?.package,
                packageId: p.package ? (p.package._id || p.package).toString() : (appt?.package ? (appt.package._id || appt.package).toString() : null),
                isPackageSale: tipo === 'Pacote' && !!p.package,
                isPrepago: !!(appt?.date && p.financialDate && moment(p.financialDate).tz('America/Sao_Paulo').startOf('day').isBefore(moment(appt.date).tz('America/Sao_Paulo').startOf('day'))),
                appointmentStatus: appt?.operationalStatus || '-',
                paymentForms: p.splitMethods || appt?.paymentForms || []
            };
        }).filter(Boolean);
        console.log(`[cashflow.v2] transacoesCaixa.process = ${Date.now() - _tTransacoesCaixa}ms (${transacoesCaixa.length} items)`);

        transacoesCaixa.sort((a, b) => a.hora.localeCompare(b.hora));

        // Recalcula totais do caixa a partir das transações já filtradas
        const totalCaixaFiltrado = transacoesCaixa.reduce((s, t) => s + t.valor, 0);
        const _splitMethodToLabel = m => {
            const ml = (m || '').toLowerCase();
            if (ml.includes('pix')) return 'Pix';
            if (ml.includes('dinheiro') || ml.includes('cash')) return 'Dinheiro';
            if (ml.includes('cartão') || ml.includes('cartao') || ml.includes('card') || ml.includes('crédito') || ml.includes('debito') || ml.includes('credit') || ml.includes('debit')) return 'Cartão';
            if (ml.includes('transfer')) return 'Transferência Bancária';
            return 'Outros';
        };
        let pixFiltrado = 0, dinheiroFiltrado = 0, cartaoFiltrado = 0, transferenciaFiltrado = 0, outrosFiltrado = 0;
        qtdPix = 0; qtdDinheiro = 0; qtdCartao = 0;
        for (const t of transacoesCaixa) {
            if (t.paymentForms?.length >= 2) {
                for (const f of t.paymentForms) {
                    const lbl = _splitMethodToLabel(f.method);
                    if (lbl === 'Pix') { pixFiltrado += f.amount; qtdPix++; }
                    else if (lbl === 'Dinheiro') { dinheiroFiltrado += f.amount; qtdDinheiro++; }
                    else if (lbl === 'Cartão') { cartaoFiltrado += f.amount; qtdCartao++; }
                    else if (lbl === 'Transferência Bancária') transferenciaFiltrado += f.amount;
                    else outrosFiltrado += f.amount;
                }
            } else {
                if (t.metodo === 'Pix') { pixFiltrado += t.valor; qtdPix++; }
                else if (t.metodo === 'Dinheiro') { dinheiroFiltrado += t.valor; qtdDinheiro++; }
                else if (t.metodo === 'Cartão') { cartaoFiltrado += t.valor; qtdCartao++; }
                else if (t.metodo === 'Transferência Bancária') transferenciaFiltrado += t.valor;
                else outrosFiltrado += t.valor;
            }
        }
        const countCaixaFiltrado = transacoesCaixa.length;

        // ========== DESPESAS DO DIA ==========
        let totalDespesas = 0;
        const despesasPorCategoria = {};
        expenses.forEach(e => {
            totalDespesas += e.amount;
            const cat = e.category || 'other';
            if (!despesasPorCategoria[cat]) despesasPorCategoria[cat] = 0;
            despesasPorCategoria[cat] += e.amount;
        });
        const saldoLiquido = totalCaixaFiltrado - totalDespesas;

        // ========== PRODUÇÃO DO DIA ==========
        const _tTransacoesProducao = Date.now();
        let producaoLiquidada = 0;
        let aReceber = 0;
        const porEspecialidade = {};
        const pendentesCobranca = [];

        const transacoesProducao = production.sessions.map(s => {
            const valor = resolveSessionFinancialValue(s);

            const patient = patientMap.get(s.patient?.toString());
            const doctor = doctorsMap.get(s.doctor?.toString());
            const appt = s.appointmentId ? appointmentsMap.get(s.appointmentId.toString()) : null;

            const patientName = patient?.fullName || appt?.patientName || appt?.patientInfo?.fullName || 'Paciente não identificado';
            const methodLower = (s.paymentMethod || '').toLowerCase();
            const isConvenio = methodLower === 'convenio' || s.paymentOrigin === 'convenio'
                || appt?.billingType === 'convenio' || s.billingType === 'convenio';
            const isLiminar = methodLower === 'liminar_credit' || s.paymentOrigin === 'liminar' || s.paymentOrigin === 'liminar_credit' || s.billingType === 'liminar';
            const isPacote = !!s.package;

            // Detecta pacote pré-pago: dinheiro entrou na compra, sessão consumida = receita realizada
            const pkgPayType = appt?.package?.paymentType || appt?.package?.model;
            const isPrepaidPkg = isPacote && (pkgPayType === 'full' || pkgPayType === 'prepaid');

            const esp = doctor?.specialty || appt?.specialty || 'Outra';
            if (!porEspecialidade[esp]) {
                porEspecialidade[esp] = { total: 0, quantidade: 0, recebido: 0, pendente: 0 };
            }
            porEspecialidade[esp].total += valor;
            porEspecialidade[esp].quantidade += 1;

            // Pacote pré-pago: sessão consumida = "paga" (money came in at package purchase)
            const foiPago = s.isPaid === true || s.paymentStatus === 'paid' || s.paymentStatus === 'package_paid' || isPrepaidPkg;
            // Convênio = produção realizada, mas pagamento vem da seguradora (não é caixa recebido)
            const categoria = isConvenio ? 'convenio' : isLiminar ? 'liminar' : (foiPago ? 'recebido' : 'a_receber');

            if (isConvenio) {
                // Convênio conta como produção realizada mas não entra em recebido/pendente de caixa
                porEspecialidade[esp].recebido += valor;
            } else if (!foiPago) {
                aReceber += valor;
                porEspecialidade[esp].pendente += valor;
                pendentesCobranca.push({
                    id: s._id,
                    paciente: patientName,
                    telefone: patient?.phone || appt?.patientInfo?.phone || '-',
                    valor,
                    horario: appt?.time || '',
                    especialidade: esp,
                    professional: doctor?.fullName || '-',
                    tipo: isPacote ? 'Pacote' : 'Particular',
                    convenio: null
                });
            } else {
                porEspecialidade[esp].recebido += valor;
                producaoLiquidada += valor;
            }

            return {
                id: s._id,
                paciente: patientName,
                valor,
                metodo: isLiminar ? 'Transferência Bancária' : (s.paymentMethod || (isConvenio ? 'Convênio' : 'Pendente')),
                tipo: isConvenio ? 'Convênio' : isLiminar ? 'Liminar' : (isPacote ? 'Pacote' : 'Particular'),
                servico: appt?.serviceType === 'evaluation' ? 'Avaliação' :
                        appt?.serviceType === 'consultation' ? 'Consulta' :
                        appt?.serviceType === 'package_session' ? 'Sessão de Pacote' :
                        appt?.serviceType === 'convenio_session' ? 'Sessão Convênio' :
                        appt?.serviceType === 'tongue_tie_test' ? 'Teste da Linguinha' :
                        appt?.serviceType === 'neuropsych_evaluation' ? 'Avaliação Neuropsicológica' :
                        appt?.serviceType === 'return' ? 'Retorno' : 'Sessão',
                especialidade: esp,
                hora: appt?.time || '',
                data: moment(s.date).format('DD/MM/YYYY'),
                status: appt?.operationalStatus || 'completed',
                categoria,
                professional: doctor?.fullName || '-',
                paymentModel: isPacote ? (isPrepaidPkg ? 'prepaid' : 'per_session') : null,
                paymentForms: (s.appointmentId ? paymentByApptId.get(s.appointmentId.toString())?.splitMethods : null) || appt?.paymentForms || []
            };
        });

        console.log(`[cashflow.v2] transacoesProducao.process = ${Date.now() - _tTransacoesProducao}ms (${transacoesProducao.length} items)`);

        // Appointments convênio sem Session document — injetar como entradas sintéticas
        const sessionCoveredApptIds = new Set(
            production.sessions.map(s => s.appointmentId?.toString()).filter(Boolean)
        );
        for (const appt of convenioAppts) {
            if (sessionCoveredApptIds.has(appt._id.toString())) continue;
            const valor = appt.insuranceValue || appt.sessionValue || 0;
            const esp = appt.doctor?.specialty || 'Outra';
            const patientName = appt.patient?.fullName || appt.patientName || appt.patientInfo?.fullName || 'Paciente não identificado';
            const serviceTypeLabel =
                appt.serviceType === 'evaluation' ? 'Avaliação' :
                appt.serviceType === 'consultation' ? 'Consulta' :
                appt.serviceType === 'convenio_session' ? 'Sessão Convênio' :
                appt.serviceType === 'package_session' ? 'Sessão de Pacote' : 'Sessão';
            if (!porEspecialidade[esp]) {
                porEspecialidade[esp] = { total: 0, quantidade: 0, recebido: 0, pendente: 0 };
            }
            porEspecialidade[esp].total += valor;
            porEspecialidade[esp].quantidade += 1;
            porEspecialidade[esp].recebido += valor;
            transacoesProducao.push({
                id: appt._id,
                paciente: patientName,
                valor,
                metodo: 'Convênio',
                tipo: 'Convênio',
                servico: serviceTypeLabel,
                especialidade: esp,
                hora: appt.time || '',
                data: moment(appt.date).format('DD/MM/YYYY'),
                status: 'completed',
                categoria: 'convenio',
                professional: appt.doctor?.fullName || '-',
                paymentModel: null
            });
        }

        // Comparativos e métricas
        const variacao = yesterdayTotal > 0
            ? ((totalCaixaFiltrado - yesterdayTotal) / yesterdayTotal * 100).toFixed(1)
            : totalCaixaFiltrado > 0 ? 100 : 0;
        const vsMediaMes = mediaDiariaMes > 0
            ? ((totalCaixaFiltrado - mediaDiariaMes) / mediaDiariaMes * 100).toFixed(1)
            : 0;
        const ticketMedio = countCaixaFiltrado > 0 ? (totalCaixaFiltrado / countCaixaFiltrado) : 0;
        const ticketMedioProducao = production.count > 0 ? (production.total / production.count) : 0;
        const taxaEficiencia = production.total > 0 ? ((producaoLiquidada / production.total) * 100).toFixed(1) : 0;

        const especialidadesResumo = Object.entries(porEspecialidade).map(([nome, dados]) => ({
            nome,
            total: dados.total,
            quantidade: dados.quantidade,
            recebido: dados.recebido,
            pendente: dados.pendente,
            ticketMedio: dados.quantidade > 0 ? (dados.total / dados.quantidade).toFixed(2) : 0
        })).sort((a, b) => b.total - a.total);

        console.log(`[cashflow.v2] TOTAL = ${Date.now() - startedAt}ms`);

        const cashflowResponsePayload = {
            success: true,
            data: {
                data: targetDate,
                caixa: {
                    total: totalCaixaFiltrado,
                    pix: pixFiltrado,
                    dinheiro: dinheiroFiltrado,
                    cartao: cartaoFiltrado,
                    transferencia: transferenciaFiltrado,
                    outros: outrosFiltrado,
                    qtdPix,
                    qtdDinheiro,
                    qtdCartao
                },
                porTipo: (() => {
                    const acc = { particular: 0, pacote: 0, convenio: 0, liminar: 0 };
                    for (const t of transacoesCaixa) {
                        if (t.tipo === 'Particular') acc.particular += t.valor;
                        else if (t.tipo === 'Pacote') acc.pacote += t.valor;
                        else if (t.tipo === 'Convênio') acc.convenio += t.valor;
                        else if (t.tipo === 'Liminar') acc.liminar += t.valor;
                    }
                    return acc;
                })(),
                porEspecialidade: porEspecialidadeCaixa,
                despesas: {
                    total: totalDespesas,
                    porCategoria: despesasPorCategoria,
                    quantidade: expenses.length
                },
                saldo: {
                    bruto: totalCaixaFiltrado,
                    liquido: saldoLiquido,
                    despesaTotal: totalDespesas
                },
                producao: {
                    total: production.total,
                    aReceber,
                    producaoLiquidada,
                    convenioAReceber: production.convenio || 0,
                    quantidadeAtendimentos: production.count,
                    ticketMedio: ticketMedioProducao,
                    taxaEficiencia: parseFloat(taxaEficiencia),
                    porTipo: {
                        particular: production.particular,
                        pacote: production.pacote,
                        convenio: production.convenio,
                        liminar: production.liminar || 0
                    },
                    porEspecialidade: especialidadesResumo
                },
                pendentesCobranca: pendentesCobranca.sort((a, b) => a.horario.localeCompare(b.horario)),
                pacotesAtendidos: transacoesProducao.filter(t => t.tipo === 'Pacote').map(t => ({
                    id: t.id,
                    horario: t.hora,
                    paciente: t.paciente,
                    servico: t.servico,
                    especialidade: t.especialidade,
                    professional: t.professional,
                    valor: t.valor,
                    statusPagamento: t.categoria === 'recebido' ? 'Pago' : 'Pendente',
                    paymentModel: t.paymentModel
                })),
                conveniosAtendidos: transacoesProducao.filter(t => t.tipo === 'Convênio').map(t => ({
                    id: t.id,
                    horario: t.hora,
                    paciente: t.paciente,
                    servico: t.servico,
                    especialidade: t.especialidade,
                    professional: t.professional,
                    valor: t.valor,
                    convenio: t.metodo === 'Convênio' ? 'Convênio' : t.metodo
                })),
                comparativos: {
                    ontem: yesterdayTotal,
                    variacaoVsOntem: parseFloat(variacao),
                    mediaDiariaMes: parseFloat(mediaDiariaMes.toFixed(2)),
                    vsMediaMes: parseFloat(vsMediaMes),
                    totalAcumuladoMes: totalMes,
                    projecaoMes: parseFloat(projecaoMes.toFixed(2)),
                    diasDecorridos: dayOfMonth
                },
                estatisticas: {
                    quantidade: countCaixaFiltrado,
                    quantidadeAtendimentos: production.count,
                    ticketMedio,
                    ontem: yesterdayTotal
                },
                transacoes: transacoesCaixa,
                transacoesProducao: transacoesProducao,
                transacoesOntem: yesterdayCash.payments
                    .filter(p => p && p.amount > 0)
                    .map(p => {
                        const apptId = p.appointment?.toString()
                            || (p.session ? yesterdaySessionToApptIdMap.get(p.session.toString()) : null);
                        const appt = apptId ? yesterdayAppointmentsMap.get(apptId) : null;
                        return {
                            hora: appt?.time || moment(p.financialDate || p.createdAt).tz('America/Sao_Paulo').format('HH:mm'),
                            valor: p.amount
                        };
                    })
            }
        };

        _setCashflowCached(cacheKey, cashflowResponsePayload);

        res.json(cashflowResponsePayload);

        logMetric('CashflowV2', 'getCashflow', {
          executionTimeMs: Date.now() - startedAt,
          date: targetDate,
          cash: totalCaixaFiltrado,
          production: production.total,
          paymentCount: countCaixaFiltrado,
          sessionCount: production.count
        });

    } catch (err) {
        logMetric('CashflowV2', 'getCashflow', {
          executionTimeMs: Date.now() - startedAt,
          date: targetDate,
          error: err.message
        });
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/v2/cashflow/month?month=2026-04
// Retorna resumo diário do mês inteiro em UMA requisição (substitui 30 chamadas diárias)
router.get('/month', auth, async (req, res) => {
    const startedAt = Date.now();
    try {
        const { month } = req.query;
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, error: 'Parâmetro month obrigatório (formato: YYYY-MM)' });
        }

        const cacheKey = _cashflowCacheKey(undefined, undefined, undefined, month);
        const currentMonthStr = moment.tz('America/Sao_Paulo').format('YYYY-MM');
        const isCurrent = month === currentMonthStr;
        const cached = _getCashflowCached(cacheKey, isCurrent ? CASHFLOW_CURRENT_TTL : CASHFLOW_PAST_TTL);
        if (cached) {
            res.set('X-Cache-Hit', 'true');
            return res.json(cached);
        }

        const [year, monthNum] = month.split('-').map(Number);
        const monthStart = moment.tz([year, monthNum - 1, 1], 'America/Sao_Paulo').startOf('day');
        const monthEnd = moment.tz([year, monthNum - 1, 1], 'America/Sao_Paulo').endOf('month').endOf('day');
        const today = moment.tz('America/Sao_Paulo').endOf('day');
        const start = monthStart.clone().utc().toDate();
        // Para o mês atual, não buscar além de hoje — evita pagamentos futuros pré-registrados
        const end = moment.min(monthEnd, today).utc().toDate();

        // 🎯 Fonte única de verdade V2
        const [cashMap, productionResult, productionTotals] = await Promise.all([
            unifiedFinancialService.calculateCashByDay(start, end),
            unifiedFinancialService.calculateProductionByDay(start, end),
            unifiedFinancialService.calculateProduction(start, end)
        ]);

        const producaoMap = productionResult.map;

        // Preenche todos os dias do mês
        const daysInMonth = monthStart.daysInMonth();
        const result = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const dayStr = moment.tz([year, monthNum - 1, d], 'America/Sao_Paulo').format('YYYY-MM-DD');
            const caixaData = cashMap.get(dayStr);
            const prodData = producaoMap.get(dayStr);
            result.push({
                date: dayStr,
                caixa: caixaData?.caixa || 0,
                producao: prodData?.producao || 0,
                atendimentos: prodData?.atendimentos || 0
            });
        }

        const caixaBruto = result.reduce((s, d) => s + d.caixa, 0);

        const responsePayload = {
            success: true,
            month,
            data: result,
            resumo: {
                caixaBruto,
                producaoTotal: productionTotals.total || 0,
                convenioAReceber: productionTotals.convenio || 0,
                porTipo: {
                    particular: productionTotals.particular || 0,
                    pacote: productionTotals.pacote || 0,
                    convenio: productionTotals.convenio || 0,
                    liminar: productionTotals.liminar || 0
                }
            }
        };

        _setCashflowCached(cacheKey, responsePayload);

        res.json(responsePayload);

        logMetric('CashflowV2', 'getCashflowMonth', {
          executionTimeMs: Date.now() - startedAt,
          month,
          caixaBruto,
          producaoTotal: productionTotals.total || 0
        });

    } catch (err) {
        logMetric('CashflowV2', 'getCashflowMonth', {
          executionTimeMs: Date.now() - startedAt,
          month,
          error: err.message
        });
        res.status(500).json({ success: false, error: err.message });
    }
});

export function clearCashflowCache(date) {
    if (date) {
        // Remove entradas do dia específico
        for (const key of _cashflowCache.keys()) {
            if (key.startsWith(date)) _cashflowCache.delete(key);
        }
    } else {
        _cashflowCache.clear();
    }
}

export default router;

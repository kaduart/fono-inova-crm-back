import axios from "axios";
import dotenv from "dotenv";
import { getIo } from "../config/socket.js";
import { getSicoobAccessToken } from "../services/sicoobAuth.js";
import { getWebhookInfo } from "../services/sicoobService.js";

dotenv.config();

/**
 * ============================================================
 * 1️⃣ REGISTRA WEBHOOK PIX NO SICOOB
 * ============================================================
 */
export const registerWebhookHandler = async (req, res) => {
  try {
    const data = await registerWebhook();
    return res.status(200).json({
      success: true,
      message: "Webhook registrado com sucesso",
      data,
    });
  } catch (error) {
    console.error("❌ Erro ao registrar webhook:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Falha ao registrar webhook",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 2️⃣ LISTA PIX RECEBIDOS
 * ============================================================
 */
export const listPixHandler = async (req, res) => {
  try {
    const token = await getSicoobAccessToken();
    const url = `${process.env.SICOOB_API_BASE_URL}/pix`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    console.log("📦 PIX recebidos:", response.data);
    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error("❌ Erro ao listar PIX:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Erro ao listar PIX",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 3️⃣ CONSULTA COBRANÇA ESPECÍFICA
 * ============================================================
 */
export const getCobrancaHandler = async (req, res) => {
  try {
    const { txid } = req.params;
    const token = await getSicoobAccessToken();
    const url = `${process.env.SICOOB_API_BASE_URL}/cob/${txid}`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("📄 Detalhes da cobrança:", response.data);
    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error("❌ Erro ao consultar cobrança:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Erro ao consultar cobrança",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 4️⃣ WEBHOOK REAL – RECEBE NOTIFICAÇÕES DO SICOOB (PIX)
 * ============================================================
 */
export const handlePixWebhook = async (req, res) => {
  try {
    console.log("📥 [PIX WEBHOOK] Chegou requisição no /api/pix/webhook");
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Body:", JSON.stringify(req.body, null, 2));

    res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

    const payload = req.body;

    if (!payload?.pix || !Array.isArray(payload.pix)) {
      console.warn("⚠️ Payload sem array 'pix':", payload);
      return;
    }

    const io = getIo();

    for (const pix of payload.pix) {
      const formattedPix = {
        txid: pix.txid,
        amount: parseFloat(pix.valor),
        date: new Date(pix.horario || Date.now()),
        payer: pix.infoPagador || pix.pagador || "Não informado",
        status: "recebido",
      };

      console.log("💸 Pix recebido:", formattedPix);
      io.emit("pix-received", formattedPix);

      processPixTransaction(formattedPix, io);
    }
  } catch (err) {
    console.error("❌ Erro ao processar webhook:", err);
    // só loga, não precisa responder nada aqui porque já mandamos 200
  }
};


/**
 * ============================================================
 * 5️⃣ PROCESSA PIX (CRIA PAGAMENTO + DISTRIBUI)
 * ============================================================
 */
/* async function processPixTransaction({ txid, amount, payer, date }, io) {
  const mongoSession = await mongoose.startSession();

  try {
    await mongoSession.startTransaction();

    const existingPayment = await Payment.findOne({ txid, status: "paid" }).session(mongoSession);
    if (existingPayment) {
      console.warn(`⚠️ PIX ${txid} já processado anteriormente.`);
      await mongoSession.abortTransaction();
      return;
    }

    // tenta achar pacote
    let pkg = await Package.findOne({ txid }).populate("sessions").session(mongoSession);
    if (!pkg) {
      const now = new Date();
      pkg = await Package.findOne({
        totalValue: { $gte: amount - 1, $lte: amount + 1 },
        createdAt: { $gte: new Date(now.getTime() - 3 * 60 * 60 * 1000) },
      }).populate("sessions").session(mongoSession);
    }

    // ⚠️ SE NÃO ACHAR PACOTE → ainda assim registrar o PIX
    if (!pkg) {
      console.warn(`⚠️ Nenhum pacote encontrado para TXID: ${txid}. Registrando PIX solto.`);

      const paymentDoc = new Payment({
        package: null,
        patient: null,
        doctor: null,
        txid,
        amount,
        paymentMethod: "pix",
        status: "unallocated",           // 👈 novo status
        serviceType: "pix_unallocated",  // 👈 livre
        kind: "pix_unallocated",
        notes: `PIX recebido sem pacote vinculado - ${payer}`,
        paymentDate: date || new Date(),
      });

      await paymentDoc.save({ session: mongoSession });
      await mongoSession.commitTransaction();

      io.emit("paymentUpdate", {
        type: "pix",
        txid,
        packageId: null,
        patient: null,
        doctor: null,
        amount,
        method: "pix",
        totalPaid: amount,
        balance: null,
        financialStatus: "unallocated",
        timestamp: new Date(),
      });

      return;
    }

    // 🔹 aqui segue o fluxo normal se achou pacote...
    const paymentDoc = new Payment({
      package: pkg._id,
      patient: pkg.patient,
      doctor: pkg.doctor,
      txid,
      amount,
      paymentMethod: "pix",
      status: "paid",
      paidAt: new Date(),  // 🔒 Obrigatório quando status='paid'
      serviceType: "package_session",
      kind: "package_receipt",
      notes: `Pagamento via PIX - ${payer}`,
      paymentDate: date || new Date(),
    });
    await paymentDoc.save({ session: mongoSession });

    await distributePayments(pkg._id, amount, mongoSession, paymentDoc._id);

    pkg.totalPaid = (pkg.totalPaid || 0) + amount;
    pkg.balance = pkg.totalSessions * pkg.sessionValue - pkg.totalPaid;
    pkg.financialStatus =
      pkg.balance <= 0 ? "paid" : pkg.totalPaid > 0 ? "partially_paid" : "unpaid";
    pkg.lastPaymentAt = new Date();
    pkg.payments.push(paymentDoc._id);

    await pkg.save({ session: mongoSession });
    await mongoSession.commitTransaction();

    console.log(`✅ PIX ${txid} aplicado com sucesso ao pacote ${pkg._id}`);

    io.emit("paymentUpdate", {
      type: "pix",
      txid,
      packageId: pkg._id,
      patient: pkg.patient,
      doctor: pkg.doctor,
      amount,
      method: "pix",
      totalPaid: pkg.totalPaid,
      balance: pkg.balance,
      financialStatus: pkg.financialStatus,
      timestamp: new Date(),
    });

  } catch (err) {
    await mongoSession.abortTransaction();
    console.error(`❌ Erro ao aplicar PIX ${txid}:`, err);
  } finally {
    await mongoSession.endSession();
  }
} */

// NÃO precisa mais de mongoose / Package / Payment / distributePayments aqui
async function processPixTransaction({ txid, amount, payer, date }, io) {
  try {
    console.log("💾 [PIX] Modo simples: só registrando notificação, sem vincular a pagamento.");

    // Exemplo: se um dia quiser salvar no banco sem amarrar nada:
    // await PixNotification.create({ txid, amount, payer, date });

  } catch (err) {
    console.error(`❌ Erro ao processar PIX ${txid} (modo notificação):`, err);
  }
}

/**
 * ============================================================
 * 🆕 GERAR COBRANÇA PIX SEM VALOR (QR GENÉRICO)
 * ============================================================
 * Cliente bipou o QR fixo -> backend cria cobrança dinâmica
 * Paciente define o valor no app bancário.
 */
export const createGenericPixHandler = async (req, res) => {
  try {
    const token = await getSicoobAccessToken();
    const baseUrl = process.env.SICOOB_API_BASE_URL;
    const chavePix = process.env.SICOOB_PIX_KEY;

    // 🔹 Gera TXID único
    const txid = `fono-${Date.now()}`;

    // 🔹 Corpo da cobrança (sem campo "valor")
    const body = {
      calendario: { expiracao: 3600 }, // 1h de validade
      chave: chavePix,
      solicitacaoPagador: "Pagamento Fono Inova 💚 (valor definido no app do banco)",
      txid,
    };

    console.log("🧾 Criando cobrança PIX genérica:", txid);

    const { data } = await axios.post(`${baseUrl}/cob`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ Cobrança PIX genérica criada:", data.txid);

    return res.status(200).json({
      success: true,
      txid,
      qrcode: data.imagemQrcode,
      location: data.loc?.location,
      expiracao: data.calendario?.expiracao,
    });
  } catch (error) {
    console.error(
      "❌ Erro ao criar cobrança PIX genérica:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Erro ao criar cobrança PIX genérica",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 3️⃣ CRIA COBRANÇA PIX DINÂMICA (GERA QR CODE E TXID)
 * ============================================================
 */
export const createDynamicPixHandler = async (req, res) => {
  try {
    const token = await getSicoobAccessToken();

    const {
      valor,
      txid,
      descricao = "Pagamento Clínica Fono Inova 💚",
      chave = process.env.SICOOB_PIX_KEY,
      solicitacaoPagador = "Informe o nome do paciente",
    } = req.body;

    if (!valor || isNaN(valor)) {
      return res.status(400).json({
        success: false,
        message: "Valor inválido para cobrança PIX.",
      });
    }

    const payload = {
      calendario: { expiracao: 3600 }, // 1h
      devedor: {
        nome: "Paciente Fono Inova",
        cpf: "00000000000",
      },
      valor: {
        original: parseFloat(valor).toFixed(2),
      },
      chave,
      solicitacaoPagador,
      infoAdicionais: [
        { nome: "Descrição", valor: descricao },
        { nome: "Sistema", valor: "Fono Inova CRM 💚" },
      ],
    };

    const url = `${process.env.SICOOB_API_BASE_URL}/cob/${txid}`;
    const response = await axios.put(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ PIX dinâmico criado com sucesso:", response.data);

    res.status(200).json({
      success: true,
      message: "Cobrança PIX gerada com sucesso.",
      data: response.data,
    });
  } catch (error) {
    console.error(
      "❌ Erro ao criar cobrança PIX:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      message: "Erro ao gerar cobrança PIX.",
      error: error.response?.data || error.message,
    });
  }
};


export const debugWebhookHandler = async (req, res) => {
  try {
    const data = await getWebhookInfo();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("❌ Erro ao consultar webhook:", e.response?.data || e.message);
    return res.status(500).json({
      success: false,
      error: e.response?.data || e.message,
    });
  }
};
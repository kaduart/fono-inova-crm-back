// dailyPaymentsReport.js
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// 🔹 Conectar ao MongoDB
await mongoose.connect(process.env.MONGO_URI);
console.log("✅ Conectado ao MongoDB");

// 🧱 Definir Schemas mínimos para evitar erro de populate
const PatientSchema = new mongoose.Schema({
    name: String,
});
const DoctorSchema = new mongoose.Schema({
    name: String,
    specialty: String,
});

// Registrar modelos para o populate funcionar
mongoose.model("Patient", PatientSchema);
mongoose.model("Doctor", DoctorSchema);

// 🔹 Model principal de Payment
const Payment = mongoose.model(
    "Payment",
    new mongoose.Schema(
        {
            patient: { type: mongoose.Schema.Types.ObjectId, ref: "Patient" },
            doctor: { type: mongoose.Schema.Types.ObjectId, ref: "Doctor" },
            amount: Number,
            paymentMethod: String,
            serviceType: String,
            kind: String,
            status: String,
            createdAt: Date,
            paymentDate: String,
        },
        { collection: "payments" }
    )
);

// 🗓️ Define o período (pode mudar a data manualmente se quiser)
const hoje = new Date();
hoje.setHours(0, 0, 0, 0);
const amanha = new Date(hoje);
amanha.setDate(hoje.getDate() + 1);

// 🔍 Busca todos os pagamentos do dia
const payments = await Payment.find({
    createdAt: { $gte: hoje, $lt: amanha },
})
    .populate("patient", "name")
    .populate("doctor", "name specialty")
    .sort({ createdAt: 1 })
    .lean();

if (!payments.length) {
    console.log("⚠️ Nenhum pagamento encontrado para o dia.");
    await mongoose.disconnect();
    process.exit(0);
}

// 🔹 Totais e agrupamentos
let totalGeral = 0;
let totalPago = 0;
let totalPendente = 0;
let porMetodo = {};
let porDoutor = {};
let porTipo = {};

payments.forEach((p) => {
    totalGeral += p.amount;
    if (p.status === "paid") totalPago += p.amount;
    else totalPendente += p.amount;

    porMetodo[p.paymentMethod] = (porMetodo[p.paymentMethod] || 0) + p.amount;
    const docName = p.doctor?.name || "Sem doutor";
    porDoutor[docName] = (porDoutor[docName] || 0) + p.amount;
    porTipo[p.serviceType] = (porTipo[p.serviceType] || 0) + p.amount;
});

// 🔸 Impressão formatada
console.log("\n===============================");
console.log("💰 RELATÓRIO DE PAGAMENTOS DIÁRIO");
console.log("===============================");
console.log(`📅 Data: ${hoje.toLocaleDateString("pt-BR")}`);
console.log(`🧾 Pagamentos encontrados: ${payments.length}`);
console.log("-------------------------------");

payments.forEach((p) => {
    console.log(`
👤 Paciente: ${p.patient?.fullName || "Desconhecido"}
🧑‍⚕️ Doutor: ${p.doctor?.fullName || "N/D"} (${p.doctor?.specialty || "N/A"})
💼 Tipo: ${p.serviceType}
💳 Método: ${p.paymentMethod}
💰 Valor: R$ ${p.amount?.toFixed(2)}
📆 Data: ${p.paymentDate}
📌 Status: ${p.status}
---------------------------------------------`);
});

console.log("\n📊 Totais:");
console.log(`• Total geral: R$ ${totalGeral.toFixed(2)}`);
console.log(`• Pago: R$ ${totalPago.toFixed(2)}`);
console.log(`• Pendente: R$ ${totalPendente.toFixed(2)}`);

console.log("\n💳 Por método:");
Object.entries(porMetodo).forEach(([m, v]) =>
    console.log(`- ${m}: R$ ${v.toFixed(2)}`)
);

console.log("\n🧑‍⚕️ Por doutor:");
Object.entries(porDoutor).forEach(([d, v]) =>
    console.log(`- ${d}: R$ ${v.toFixed(2)}`)
);

console.log("\n📋 Por tipo:");
Object.entries(porTipo).forEach(([t, v]) =>
    console.log(`- ${t}: R$ ${v.toFixed(2)}`)
);

await mongoose.disconnect();
console.log("\n✅ Relatório finalizado com sucesso.\n");

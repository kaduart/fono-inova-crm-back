// === AUDITORIA DE DUPLICAÇÕES ===

// Função para imprimir resultados bonitinho
function printDuplications(title, docs, fields) {
  print(`\n🔁 ${title}:`);
  if (docs.length === 0) {
    print('✅ Nenhum duplicado encontrado.');
  } else {
    docs.forEach(doc => {
      const info = fields.map(f => `${f}: ${doc._id[f]}`).join(', ');
      print(`- ${info}, Duplicados: ${doc.count}, IDs: ${doc.ids.join(', ')}`);
    });
  }
}

(async function() {
  // Sessões duplicadas: paciente + médico + data + hora
  const duplicatedSessions = await db.sessions.aggregate([
    {
      $match: {
        patient: { $ne: null },
        doctor: { $ne: null },
        date: { $ne: null },
        time: { $ne: null }
      }
    },
    {
      $group: {
        _id: {
          patient: "$patient",
          doctor: "$doctor",
          date: "$date",
          time: "$time"
        },
        count: { $sum: 1 },
        ids: { $push: "$_id" }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  // Agendamentos duplicados: paciente + médico + data + hora
  const duplicatedAppointments = await db.appointments.aggregate([
    {
      $match: {
        patient: { $ne: null },
        doctor: { $ne: null },
        date: { $ne: null },
        time: { $ne: null }
      }
    },
    {
      $group: {
        _id: {
          patient: "$patient",
          doctor: "$doctor",
          date: "$date",
          time: "$time"
        },
        count: { $sum: 1 },
        ids: { $push: "$_id" }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  // Pagamentos duplicados: paciente + valor + dia + método
  const duplicatedPayments = await db.payments.aggregate([
    {
      $match: {
        patient: { $ne: null },
        amount: { $ne: null },
        paymentMethod: { $ne: null },
        createdAt: { $ne: null }
      }
    },
    {
      $group: {
        _id: {
          patient: "$patient",
          amount: "$amount",
          paymentMethod: "$paymentMethod",
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        },
        count: { $sum: 1 },
        ids: { $push: "$_id" }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  print("=== AUDITORIA DE DUPLICAÇÕES ===");

  printDuplications(
    "Sessões duplicadas (paciente + médico + data + hora)",
    duplicatedSessions,
    ["patient", "doctor", "date", "time"]
  );

  printDuplications(
    "Agendamentos duplicados (paciente + médico + data + hora)",
    duplicatedAppointments,
    ["patient", "doctor", "date", "time"]
  );

  printDuplications(
    "Pagamentos duplicados (paciente + valor + dia + método)",
    duplicatedPayments,
    ["patient", "amount", "day", "paymentMethod"]
  );

  print("\n✅ Fim da auditoria.");
})();

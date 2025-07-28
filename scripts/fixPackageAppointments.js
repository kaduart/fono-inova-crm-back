// fixPackageAppointments.js

print("🔍 Buscando todos os pacotes...");

const packages = db.packages.find().toArray();

packages.forEach(pkg => {
  print(`📦 Pacote ${pkg._id}`);

  const sessionIds = pkg.sessions || [];

  if (sessionIds.length === 0) {
    print("⚠️ Pacote sem sessões, pulando.");
    return;
  }

  const appointments = db.appointments.find({ session: { $in: sessionIds } }).toArray();

  if (appointments.length === 0) {
    print("⚠️ Nenhum agendamento encontrado para as sessões desse pacote.");
    return;
  }

  const appointmentIds = appointments.map(a => a._id);

  const result = db.packages.updateOne(
    { _id: pkg._id },
    { $set: { appointments: appointmentIds } }
  );

  if (result.modifiedCount > 0) {
    print(`✅ Pacote ${pkg._id} atualizado com ${appointmentIds.length} agendamento(s)`);
  } else {
    print(`ℹ️ Pacote ${pkg._id} já atualizado ou não modificado`);
  }
});

print("\n✅ Script concluído!");

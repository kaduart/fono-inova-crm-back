// updateSessionsTime-final.js

// 1. Corrigir associação entre appointments e sessions
print("Corrigindo associação entre appointments e sessions...");
var problemSessions = [
    "6842e16d08fda3dbe2847ca9",
    "6842e16d08fda3dbe2847caa",
    "6842e16d08fda3dbe2847cab",
    "6842e16d08fda3dbe2847cac",
    "6842e16d08fda3dbe2847cad",
    "6842e16d08fda3dbe2847cae",
    "6842e16d08fda3dbe2847caf",
    "6842e16d08fda3dbe2847cb0",
    "6842e1e308fda3dbe2847d4a",
    "6842e1e308fda3dbe2847d4b",
    "6842e1e308fda3dbe2847d4c",
    "6842e1e308fda3dbe2847d4d",
    "68658aa851eb836143ace7b9"
];

// Para cada sessão problemática, encontrar o appointment correspondente
problemSessions.forEach(function(sessionId) {
    var appointment = db.appointments.findOne({ session: ObjectId(sessionId) });
    
    if (appointment && appointment.time) {
        // Atualizar a sessão com o horário do appointment
        db.sessions.updateOne(
            { _id: ObjectId(sessionId) },
            { $set: { time: appointment.time } }
        );
        print(`♻️ Atualizada sessão ${sessionId} com horário do appointment: ${appointment.time}`);
    } else {
        // Definir horário padrão para casos sem appointment
        db.sessions.updateOne(
            { _id: ObjectId(sessionId) },
            { $set: { time: "09:00" } }
        );
        print(`⏰ Definido horário padrão para sessão ${sessionId}`);
    }
});

// 2. Atualizar sessões restantes sem horário
print("\nAtualizando sessões restantes sem horário...");
var remainingSessions = db.sessions.find({
    $or: [
        { time: { $exists: false } },
        { time: null },
        { time: "" }
    ]
});

remainingSessions.forEach(function(session) {
    if (session.date) {
        // Extrair horário da data se disponível
        var dateObj = session.date;
        if (typeof dateObj === 'string') dateObj = new Date(dateObj);
        
        var hours = dateObj.getHours().toString().padStart(2, '0');
        var minutes = dateObj.getMinutes().toString().padStart(2, '0');
        var timeString = `${hours}:${minutes}`;
        
        db.sessions.updateOne(
            { _id: session._id },
            { $set: { time: timeString } }
        );
        print(`⏱️ Atualizada sessão ${session._id} para horário ${timeString} a partir da data`);
    } else {
        // Definir horário padrão para casos sem data
        db.sessions.updateOne(
            { _id: session._id },
            { $set: { time: "09:00" } }
        );
        print(`⏰ Definido horário padrão para sessão ${session._id}`);
    }
});

// Verificação final
print("\nVerificando sessões ainda sem horário...");
var finalCheck = db.sessions.find({
    $or: [
        { time: { $exists: false } },
        { time: null },
        { time: "" }
    ]
}).count();

print(`✅ Migração concluída! Sessões sem horário restantes: ${finalCheck}`);
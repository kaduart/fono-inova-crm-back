// utils/doctorHelper.js
import Doctor from "../models/Doctor.js";

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeDoctorName = (str = "") =>
    str
        .trim()
        .replace(/\b(dr|dra|doutor|doutora)\.?\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

const mapDoctor = (doc) => ({
    _id: doc._id.toString(),
    fullName: doc.fullName,
    specialty: doc.specialty,
});

/**
 * Busca doctor no MongoDB pelo nome (case-insensitive, fuzzy match)
 * @param {string} name
 * @returns {Object|null} - { _id, fullName, specialty } ou null
 */
export async function findDoctorByName(name) {
    if (!name || typeof name !== "string") {
        throw new Error("Nome do profissional é obrigatório");
    }

    const normalizedName = normalizeDoctorName(name);

    try {
        // 1) Match exato (case-insensitive)
        let doctor = await Doctor.findOne({
            fullName: { $regex: new RegExp(`^${escapeRegex(normalizedName)}$`, "i") },
            active: true,
        })
            .select("_id fullName specialty")
            .lean();

        if (doctor) return mapDoctor(doctor);

        // 2) Candidatos (match parcial)
        const candidates = await Doctor.find({
            fullName: { $regex: new RegExp(escapeRegex(normalizedName), "i") },
            active: true,
        })
            .select("_id fullName specialty")
            .sort({ fullName: 1 })
            .limit(5)
            .lean();

        if (candidates.length === 1) return mapDoctor(candidates[0]);

        if (candidates.length > 1) {
            console.warn(
                `[DOCTOR-HELPER] Ambíguo: "${name}" → ${candidates
                    .map((c) => c.fullName)
                    .join(" | ")}`
            );
            // por enquanto retorna o primeiro; se quiser, pode retornar null e forçar escolha
            return mapDoctor(candidates[0]);
        }

        console.error(`[DOCTOR-HELPER] Profissional não encontrado: "${name}"`);
        return null;
    } catch (error) {
        console.error("[DOCTOR-HELPER] Erro ao buscar profissional:", error);
        throw error;
    }
}

export async function listActiveDoctors() {
    try {
        const doctors = await Doctor.find({ active: true })
            .select("_id fullName specialty")
            .sort({ fullName: 1 })
            .lean();

        return doctors.map(mapDoctor);
    } catch (error) {
        console.error("[DOCTOR-HELPER] Erro ao listar profissionais:", error);
        throw error;
    }
}

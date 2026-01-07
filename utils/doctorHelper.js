// utils/doctorHelper.js - VERSÃO COM CACHE
import Doctor from "../models/Doctor.js";

import { redisConnection as redis } from "../config/redisConnection.js";

const CACHE_TTL = 300; // 5 minutos
const CACHE_PREFIX = "doctor:";

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
 * Busca doctor no MongoDB pelo nome (com cache Redis)
 */
export async function findDoctorByName(name) {
    if (!name || typeof name !== "string") {
        throw new Error("Nome do profissional é obrigatório");
    }

    const normalizedName = normalizeDoctorName(name);
    const cacheKey = `${CACHE_PREFIX}name:${normalizedName.toLowerCase()}`;

    try {
        // 1) Tenta cache primeiro
        const cached = await redis.get(cacheKey).catch(() => null);
        if (cached) {
            console.log(`[DOCTOR-HELPER] Cache hit: ${normalizedName}`);
            return JSON.parse(cached);
        }

        // 2) Match exato (case-insensitive)
        let doctor = await Doctor.findOne({
            fullName: { $regex: new RegExp(`^${escapeRegex(normalizedName)}$`, "i") },
            active: true,
        })
            .select("_id fullName specialty")
            .lean();

        if (doctor) {
            const result = mapDoctor(doctor);
            await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result)).catch(() => { });
            return result;
        }

        // 3) Candidatos (match parcial)
        const candidates = await Doctor.find({
            fullName: { $regex: new RegExp(escapeRegex(normalizedName), "i") },
            active: true,
        })
            .select("_id fullName specialty")
            .sort({ fullName: 1 })
            .limit(5)
            .lean();

        if (candidates.length === 1) {
            const result = mapDoctor(candidates[0]);
            await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result)).catch(() => { });
            return result;
        }

        if (candidates.length > 1) {
            console.warn(
                `[DOCTOR-HELPER] Ambíguo: "${name}" → ${candidates.map((c) => c.fullName).join(" | ")}`
            );
            const result = mapDoctor(candidates[0]);
            await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result)).catch(() => { });
            return result;
        }

        // 4) Não encontrado - cache null por menos tempo
        await redis.setex(cacheKey, 60, JSON.stringify(null)).catch(() => { });
        console.error(`[DOCTOR-HELPER] Profissional não encontrado: "${name}"`);
        return null;
    } catch (error) {
        console.error("[DOCTOR-HELPER] Erro ao buscar profissional:", error);
        throw error;
    }
}

/**
 * Lista todos os profissionais ativos (com cache)
 */
export async function listActiveDoctors() {
    const cacheKey = `${CACHE_PREFIX}all:active`;

    try {
        // Tenta cache
        const cached = await redis.get(cacheKey).catch(() => null);
        if (cached) {
            console.log("[DOCTOR-HELPER] Cache hit: listActiveDoctors");
            return JSON.parse(cached);
        }

        const doctors = await Doctor.find({ active: true })
            .select("_id fullName specialty")
            .sort({ fullName: 1 })
            .lean();

        const result = doctors.map(mapDoctor);
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result)).catch(() => { });

        return result;
    } catch (error) {
        console.error("[DOCTOR-HELPER] Erro ao listar profissionais:", error);
        throw error;
    }
}

/**
 * Invalida cache de profissionais (chamar após criar/editar/deletar)
 */
export async function invalidateDoctorCache() {
    try {
        const keys = await redis.keys(`${CACHE_PREFIX}*`);
        if (keys.length > 0) {
            await redis.del(...keys);
            console.log(`[DOCTOR-HELPER] Cache invalidado: ${keys.length} keys`);
        }
    } catch (error) {
        console.error("[DOCTOR-HELPER] Erro ao invalidar cache:", error);
    }
}
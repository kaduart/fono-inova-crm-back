// routes/proxyMedia.js
import axios from "axios";
import crypto from "crypto";
import express from "express";

// 👉 usa a sua conexão única de Redis (singleton)
import { redisConnection as redis } from "../config/redisConnection.js"; // <-- este arquivo é o seu
import { mediaLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

// Domínios permitidos (previne SSRF)
const ALLOWED_HOSTS = new Set(["lookaside.fbsbx.com", "graph.facebook.com"]);
const TTL_SECONDS = 24 * 60 * 60; // 24h
const URL_MAX_LENGTH = 1200;

const hashKey = (url) => "media:" + crypto.createHash("sha1").update(url).digest("hex");

const isAllowedUrl = (raw) => {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
};

// rate-limit dedicado só para esta rota
router.use("/proxy-media", mediaLimiter);

router.get("/proxy-media", async (req, res) => {
    const startedAt = Date.now();

    try {
        const { url } = req.query;

        if (!url || typeof url !== "string") {
            return res.status(400).json({ success: false, error: 'Parâmetro "url" é obrigatório' });
        }
        if (url.length > URL_MAX_LENGTH || url.toLowerCase().includes("http://")) {
            return res.status(400).json({ success: false, error: "URL inválida" });
        }
        if (!isAllowedUrl(url)) {
            return res.status(400).json({ success: false, error: "URL inválida para proxy" });
        }

        // token do WhatsApp Business (Meta Graph)
        const token = process.env.WHATSAPP_ACCESS_TOKEN;
        if (!token) {
            return res.status(500).json({ success: false, error: "Token do WhatsApp não configurado" });
        }

        const key = hashKey(url);

        // 1) tenta cache
        const cached = await redis.getBuffer(key);
        const cachedType = await redis.get(`${key}:type`);
        if (cached && cachedType) {
            const etag = crypto.createHash("sha1").update(cached).digest("hex");
            if (req.headers["if-none-match"] === etag) {
                return res.status(304).end();
            }
            res.setHeader("Content-Type", cachedType);
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("ETag", etag);
            res.send(cached);
            console.log(`🟢 proxy-media HIT (${cachedType}, ${cached.length} bytes) em ${Date.now() - startedAt}ms`);
            return;
        }

        // 2) baixa do Meta com token
        const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 20000,
            headers: {
                Authorization: `Bearer ${token}`,
                "User-Agent": "FonoInovaProxy/1.0",
                Accept: "*/*",
            },
            validateStatus: (s) => s >= 200 && s < 400,
        });

        const contentType = response.headers["content-type"] || "application/octet-stream";
        const body = Buffer.from(response.data);

        // 3) salva no Redis (buffer + content-type)
        await redis.set(key, body, "EX", TTL_SECONDS);
        await redis.set(`${key}:type`, contentType, "EX", TTL_SECONDS);

        // 4) responde ao cliente
        const etag = crypto.createHash("sha1").update(body).digest("hex");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("ETag", etag);
        res.send(body);

        console.log(`🟡 proxy-media MISS (${contentType}, ${body.length} bytes) em ${Date.now() - startedAt}ms`);
    } catch (err) {
        const status = err.response?.status || 500;

        // se recebeu 403/404 do Meta, invalida cache preventivamente
        if (req.query?.url) {
            try {
                const key = hashKey(String(req.query.url));
                await redis.del(key);
                await redis.del(`${key}:type`);
            } catch { }
        }

        console.error("🔴 proxy-media ERROR:", { status, message: err.message });

        if (status === 403) return res.status(403).json({ success: false, error: "Acesso negado pelo provedor de mídia" });
        if (status === 404) return res.status(404).json({ success: false, error: "Mídia não encontrada no provedor" });
        if (err.code === "ECONNABORTED") return res.status(504).json({ success: false, error: "Timeout ao buscar mídia" });

        return res.status(500).json({ success: false, error: "Falha ao carregar mídia", details: err.message });
    }
});

// rota de teste
router.get("/proxy-media/test", (req, res) => {
    res.json({ success: true, message: "proxy-media OK", ts: new Date().toISOString() });
});

export default router;

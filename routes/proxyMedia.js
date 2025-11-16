// routes/proxyMedia.js
import axios from "axios";
import crypto from "crypto";
import express from "express";
import { redisConnection as redis } from "../config/redisConnection.js";
import { mediaLimiter } from "../middleware/rateLimiter.js";
import { getMetaToken } from "../utils/metaToken.js";

const router = express.Router();

const ALLOWED_HOSTS = new Set(["lookaside.fbsbx.com", "graph.facebook.com"]);
const TTL_SECONDS = 24 * 60 * 60;
const URL_MAX_LENGTH = 1200;

const hashKey = (s) => "media:" + crypto.createHash("sha1").update(s).digest("hex");

const isAllowedUrl = (raw) => {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
};

router.use("/proxy-media", mediaLimiter);

router.get("/proxy-media", async (req, res) => {
    const startedAt = Date.now();
    const token = await getMetaToken();
    if (!token) {
        return res.status(500).json({
            success: false,
            error:
                "Token do WhatsApp não configurado (verifique WHATSAPP_ACCESS_TOKEN, META_WABA_TOKEN ou SHORT_TOKEN)",
        });
    }

    try {
        const { url, mediaId } = req.query;

        // --- Fluxo A: preferir mediaId (URL sempre fresca via Graph)
        if (typeof mediaId === "string" && mediaId.trim().length > 0) {
            const id = mediaId.trim();

            // cache por ID (conteúdo e content-type)
            const cacheKey = `media:id:${id}`;
            const cached = await redis.getBuffer(cacheKey);
            const cachedType = await redis.get(`${cacheKey}:type`);
            if (cached && cachedType) {
                const etag = crypto.createHash("sha1").update(cached).digest("hex");
                if (req.headers["if-none-match"] === etag) return res.status(304).end();
                res.setHeader("Content-Type", cachedType);
                res.setHeader("Cache-Control", "public, max-age=86400");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("ETag", etag);
                res.send(cached);
                console.log(`🟢 proxy-media(HIT-ID) ${id} (${cachedType}, ${cached.length} bytes) em ${Date.now() - startedAt}ms`);
                return;
            }

            // 1) resolve URL FRESCA no Graph
            const meta = await axios.get(
                `https://graph.facebook.com/v21.0/${encodeURIComponent(id)}?fields=url,mime_type,sha256,file_size`,
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000, validateStatus: s => s >= 200 && s < 500 }
            );

            if (meta.status === 404) {
                // mídia não existe mais no Graph
                return res.status(404).json({ success: false, error: "Mídia não disponível (Graph 404)" });
            }
            if (meta.status >= 400) {
                return res.status(meta.status).json({ success: false, error: `Falha ao resolver mediaId (${meta.status})` });
            }

            const freshUrl = meta.data?.url;
            const mime = meta.data?.mime_type || "application/octet-stream";
            if (!freshUrl) return res.status(502).json({ success: false, error: "Graph não retornou url" });

            // 2) baixa o binário da URL fresca
            const bin = await axios.get(freshUrl, {
                responseType: "arraybuffer",
                timeout: 20000,
                headers: { Authorization: `Bearer ${token}`, Accept: "*/*", "User-Agent": "FonoInovaProxy/1.0" },
                validateStatus: (s) => s >= 200 && s < 400,
            });

            const body = Buffer.from(bin.data);
            const contentType = bin.headers["content-type"] || mime;

            // 3) cacheia por ID
            await redis.set(cacheKey, body, "EX", TTL_SECONDS);
            await redis.set(`${cacheKey}:type`, contentType, "EX", TTL_SECONDS);

            // 4) responde
            const etag = crypto.createHash("sha1").update(body).digest("hex");
            res.setHeader("Content-Type", contentType);
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("ETag", etag);
            res.send(body);

            console.log(`🟡 proxy-media(MISS-ID) ${id} (${contentType}, ${body.length} bytes) em ${Date.now() - startedAt}ms`);
            return;
        }

        // --- Fluxo B: compatibilidade com ?url= (antigo)
        if (!url || typeof url !== "string") {
            return res.status(400).json({ success: false, error: 'Parâmetro "mediaId" ou "url" é obrigatório' });
        }
        if (url.length > URL_MAX_LENGTH || url.toLowerCase().includes("http://")) {
            return res.status(400).json({ success: false, error: "URL inválida" });
        }
        if (!isAllowedUrl(url)) {
            return res.status(400).json({ success: false, error: "URL inválida para proxy" });
        }

        const key = hashKey(url);
        const cached = await redis.getBuffer(key);
        const cachedType = await redis.get(`${key}:type`);
        if (cached && cachedType) {
            const etag = crypto.createHash("sha1").update(cached).digest("hex");
            if (req.headers["if-none-match"] === etag) return res.status(304).end();
            res.setHeader("Content-Type", cachedType);
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("ETag", etag);
            res.send(cached);
            console.log(`🟢 proxy-media(HIT-URL) (${cachedType}, ${cached.length} bytes) em ${Date.now() - startedAt}ms`);
            return;
        }

        // baixa pela URL (pode dar 404 se expirou)
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

        await redis.set(key, body, "EX", TTL_SECONDS);
        await redis.set(`${key}:type`, contentType, "EX", TTL_SECONDS);

        const etag = crypto.createHash("sha1").update(body).digest("hex");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("ETag", etag);
        res.send(body);

        console.log(`🟡 proxy-media(MISS-URL) (${contentType}, ${body.length} bytes) em ${Date.now() - startedAt}ms`);
    } catch (err) {
        const status = err.response?.status || 500;

        // limpa cache preventivamente
        try {
            const { url, mediaId } = req.query;
            if (mediaId) {
                const k = `media:id:${mediaId}`;
                await redis.del(k); await redis.del(`${k}:type`);
            } else if (url) {
                const k = hashKey(String(url));
                await redis.del(k); await redis.del(`${k}:type`);
            }
        } catch { }

        console.error("🔴 proxy-media ERROR:", { status, message: err.message });

        if (status === 403) return res.status(403).json({ success: false, error: "Acesso negado pelo provedor de mídia" });
        if (status === 404) return res.status(404).json({ success: false, error: "Mídia não encontrada no provedor" });
        if (err.code === "ECONNABORTED") return res.status(504).json({ success: false, error: "Timeout ao buscar mídia" });

        return res.status(500).json({ success: false, error: "Falha ao carregar mídia", details: err.message });
    }
});

router.get("/proxy-media/test", (req, res) => {
    res.json({ success: true, message: "proxy-media OK", ts: new Date().toISOString() });
});

export default router;

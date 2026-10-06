// routes/proxyMedia.js
import axios from "axios";
import crypto from "crypto";
import express from "express";
import { redisConnection as redis } from "../config/redisConnection.js";
import { mediaLimiter } from "../middleware/rateLimiter.js";
import { getMetaToken } from "../utils/metaToken.js";
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

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
        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "Token do WhatsApp não configurado (verifique WHATSAPP_ACCESS_TOKEN, META_WABA_TOKEN ou META_WABA_TOKEN)", {
            status: 500,
          }),
          req
        );
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
                return sendApiError(
                  res,
                  new AppError('NOT_FOUND', "Mídia não disponível (Graph 404)", {
                    status: 404,
                  }),
                  req
                );
            }
            if (meta.status >= 400) {
                return res.status(meta.status).json({ success: false, error: `Falha ao resolver mediaId (${meta.status})` });
            }

            const freshUrl = meta.data?.url;
            const mime = meta.data?.mime_type || "application/octet-stream";
            if (!freshUrl) return sendApiError(res, new AppError('INTERNAL_ERROR', "Graph não retornou url", { status: 502 }), req);

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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Parâmetro "mediaId" ou "url" é obrigatório', {
                status: 400,
              }),
              req
            );
        }
        if (url.length > URL_MAX_LENGTH || url.toLowerCase().includes("http://")) {
            return sendApiError(res, new AppError('BAD_REQUEST', "URL inválida", { status: 400 }), req);
        }
        if (!isAllowedUrl(url)) {
            return sendApiError(res, new AppError('BAD_REQUEST', "URL inválida para proxy", { status: 400 }), req);
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

        // Extrai mid da URL fbsbx e usa como mediaId para buscar URL fresca
        try {
            const parsedUrl = new URL(url);
            const mid = parsedUrl.searchParams.get('mid');
            if (mid) {
                const cacheKey = `media:id:${mid}`;
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
                    console.log(`🟢 proxy-media(HIT-MID) ${mid} em ${Date.now() - startedAt}ms`);
                    return;
                }
                const meta = await axios.get(
                    `https://graph.facebook.com/v21.0/${encodeURIComponent(mid)}?fields=url,mime_type`,
                    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000, validateStatus: s => s >= 200 && s < 500 }
                );
                if (meta.status < 400 && meta.data?.url) {
                    const bin = await axios.get(meta.data.url, {
                        responseType: "arraybuffer", timeout: 20000,
                        headers: { Authorization: `Bearer ${token}`, Accept: "*/*", "User-Agent": "FonoInovaProxy/1.0" },
                        validateStatus: (s) => s >= 200 && s < 400,
                    });
                    const body = Buffer.from(bin.data);
                    const contentType = bin.headers["content-type"] || meta.data.mime_type || "application/octet-stream";
                    await redis.set(cacheKey, body, "EX", TTL_SECONDS);
                    await redis.set(`${cacheKey}:type`, contentType, "EX", TTL_SECONDS);
                    const etag = crypto.createHash("sha1").update(body).digest("hex");
                    res.setHeader("Content-Type", contentType);
                    res.setHeader("Cache-Control", "public, max-age=86400");
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("ETag", etag);
                    res.send(body);
                    console.log(`🟡 proxy-media(MISS-MID) ${mid} (${contentType}, ${body.length} bytes) em ${Date.now() - startedAt}ms`);
                    return;
                }
            }
        } catch { /* cai no download direto abaixo */ }

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

        // tenta pegar query pra log
        const { url, mediaId } = req.query;

        // limpa cache preventivamente
        try {
            if (mediaId) {
                const k = `media:id:${mediaId}`;
                await redis.del(k);
                await redis.del(`${k}:type`);
            } else if (url) {
                const k = hashKey(String(url));
                await redis.del(k);
                await redis.del(`${k}:type`);
            }
        } catch { }

        console.error("🔴 proxy-media ERROR:", {
            status,
            message: err.message,
            mediaId,
            url,
            providerUrl: err.config?.url,
            method: err.config?.method,
            responseData: err.response?.data, // AQUI vem o erro detalhado do Graph / lookaside
        });

        if (status === 403)
            return sendApiError(
              res,
              new AppError('FORBIDDEN', "Acesso negado pelo provedor de mídia", {
                status: 403,
              }),
              req
            );
        if (status === 404)
            return sendApiError(
              res,
              new AppError('NOT_FOUND', "Mídia não encontrada no provedor", {
                status: 404,
              }),
              req
            );
        if (err.code === "ECONNABORTED")
            return sendApiError(res, new AppError('INTERNAL_ERROR', "Timeout ao buscar mídia", { status: 504 }), req);

        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "Falha ao carregar mídia", {
            status: 500,
            details: err.message,
          }),
          req
        );
    }
});

router.get("/proxy-media/test", (req, res) => {
    res.json({ success: true, message: "proxy-media OK", ts: new Date().toISOString() });
});

export default router;

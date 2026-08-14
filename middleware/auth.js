import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

// Cache em memória de userModel.exists() — TODA request autenticada passa por
// aqui, então sem cache é um round-trip ao Mongo por request, mesmo quando a
// rota em si devolve 304 (a checagem roda antes do handler decidir isso).
// Mesmo padrão de TTL curto já usado em unifiedFinancialService.v2.js
// (_ufsCache) e financialDashboard.v2.js (_dashCache): dentro da janela, zero
// round-trip extra por usuário repetido; fora dela, volta a checar o Mongo.
//
// Trade-off aceito conscientemente: um usuário deletado/desativado pode
// continuar autenticado por até USER_EXISTS_CACHE_TTL a mais do que antes.
// A defesa primária contra token roubado/revogado continua sendo a expiração
// do próprio JWT (mais longa que este TTL); isto só encurta o round-trip do
// caminho feliz, não substitui a checagem — ela ainda roda, só que com menos
// frequência por usuário.
const _userExistsCache = new Map();
const USER_EXISTS_CACHE_TTL = 30_000; // 30s

function _getUserExistsCached(key) {
    const entry = _userExistsCache.get(key);
    if (entry && Date.now() - entry.ts < USER_EXISTS_CACHE_TTL) {
        return entry;
    }
    return undefined;
}

function _setUserExistsCached(key, exists) {
    // Limite defensivo: a base de usuários (Admin/Doctor) de uma clínica é
    // pequena (dezenas), não deveria nem chegar perto disso — mas evita
    // crescimento sem limite se o padrão de uso mudar.
    if (_userExistsCache.size > 500) _userExistsCache.clear();
    _userExistsCache.set(key, { exists, ts: Date.now() });
}

export const auth = async (req, res, next) => {
    try {
        // Verificar token no cookie, header ou query string (para SSE/EventSource)
        const token = req.cookies?.token || 
                      req.headers.authorization?.split(' ')[1] || 
                      req.query?.token;
        if (!token) {
            return res.status(401).json({
                code: 'TOKEN_REQUIRED',
                message: 'Token não fornecido',
                redirect: true
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secreta');

        // Validação reforçada do payload
        if (!decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
            return res.status(401).json({
                code: 'INVALID_TOKEN_PAYLOAD',
                message: 'Estrutura do token inválida'
            });
        }

        // Verificação otimizada de usuário — cacheada por USER_EXISTS_CACHE_TTL
        // (ver comentário no topo do arquivo)
        const modelName = decoded.role === 'admin' || decoded.role === 'secretary' ? 'Admin' : 'Doctor';
        const cacheKey = `${modelName}:${decoded.id}`;

        let userExists;
        const cached = _getUserExistsCached(cacheKey);
        if (cached) {
            userExists = cached.exists;
        } else {
            const userModel = mongoose.model(modelName);
            userExists = !!(await userModel.exists({ _id: decoded.id }));
            _setUserExistsCached(cacheKey, userExists);
        }

        if (!userExists) {
            return res.status(401).json({
                code: 'USER_NOT_FOUND',
                message: 'Usuário não encontrado'
            });
        }

        req.user = {
            id: decoded.id,
            role: decoded.role
        };

        next();
    } catch (err) {
        console.error(`[Auth Error] ${err.name}: ${err.message}`);

        // Respostas padronizadas
        const errorResponse = {
            'TokenExpiredError': {
                code: 'TOKEN_EXPIRED',
                message: 'Sessão expirada',
                redirect: true
            },
            'JsonWebTokenError': {
                code: 'INVALID_TOKEN',
                message: 'Token inválido'
            }
        }[err.name] || {
            code: 'AUTH_FAILED',
            message: 'Falha na autenticação'
        };

        res.status(401).json(errorResponse);
    }
};

// Middleware de autorização dinâmica
export const authorize = (roles = []) => {
    return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return res.status(403).json({
                code: 'FORBIDDEN',
                message: 'Acesso negado para seu perfil'
            });
        }
        next();
    };
};


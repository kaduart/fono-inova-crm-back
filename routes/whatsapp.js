import express from 'express';
import multer from 'multer';
import { getIo } from '../config/socket.js';
import { whatsappController } from '../controllers/whatsappController.js';
import { whatsappGuard, healthCheck, getGuardStats } from '../middleware/whatsappGuard.js';

const router = express.Router();

// Log para debug de tamanho de requisições
router.use((req, res, next) => {
    if (req.path.includes('send-media') || req.path.includes('upload-media')) {
        console.log('📊 [WhatsApp Route] Requisição recebida:', {
            path: req.path,
            method: req.method,
            contentLength: req.headers['content-length'],
            contentType: req.headers['content-type']?.substring(0, 50)
        });
    }
    next();
});

// Configuração do multer para upload de arquivos
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB max (limite aumentado para arquivos maiores)
    },
    fileFilter: (req, file, cb) => {
        // Tipos permitidos pelo WhatsApp
        const allowedMimeTypes = [
            // Imagens
            'image/jpeg', 'image/png', 'image/webp', 'image/gif',
            // Áudio
            'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/webm;codecs=opus', 'audio/mp4',
            // Vídeo
            'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
            // Documentos
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ];
        
        console.log('📁 [Multer] Arquivo recebido:', {
            name: file.originalname,
            type: file.mimetype,
            size: file.size
        });
        
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipo de arquivo não suportado: ${file.mimetype}`), false);
        }
    }
});

// 📤 Envio de mensagens
router.post('/send-template', whatsappController.sendTemplate);
router.post('/send-text', whatsappController.sendText);
router.delete('/messages/:id', whatsappController.deletarMsgChat);

// Middleware de tratamento de erro do multer
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        // Erro específico do multer
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                error: 'Arquivo muito grande. Limite máximo: 50MB'
            });
        }
        return res.status(400).json({
            success: false,
            error: `Erro no upload: ${err.message}`
        });
    } else if (err) {
        // Outro tipo de erro
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }
    next();
};

// 🎬 Envio de mídia
router.post('/upload-media', upload.single('file'), handleMulterError, whatsappController.uploadMedia);
router.post('/send-media', upload.single('file'), handleMulterError, whatsappController.sendMedia);

// 📩 Webhook (mensagens recebidas E status de entrega)
// 🛡️ Guard ativo: log bruto + captura fail-safe antes do processamento
router.post('/webhook', whatsappGuard, whatsappController.webhook);
router.get('/webhook', whatsappController.getWebhook);

// 🛡️ Health Check e Monitoramento
router.get('/health', healthCheck);
router.get('/guard/stats', getGuardStats);

// 🧪 Teste de socket
router.post('/test-socket', (req, res) => {
    try {
        const io = getIo();
        
        // 🔍 DEBUG: Informações sobre conexões
        const sockets = Array.from(io.sockets?.sockets || []);
        console.log('🔍 [TEST SOCKET] Total de clientes conectados:', io.engine?.clientsCount || 0);
        console.log('🔍 [TEST SOCKET] Socket IDs:', sockets.map(([id]) => id));
        
        const testPayload = {
            id: `test-${Date.now()}`,
            from: req.body.from || '5511999999999',
            to: req.body.to || '5511888888888',
            direction: 'inbound',
            type: 'text',
            content: req.body.message || 'Mensagem de teste do socket',
            text: req.body.message || 'Mensagem de teste do socket',
            status: 'received',
            timestamp: Date.now(),
            leadId: 'test-lead-id',
            contactId: 'test-contact-id',
            contactName: req.body.contactName || 'Teste'
        };
        
        console.log('🧪 [TEST SOCKET] Emitindo evento:', testPayload);
        
        // Emitir para todos os clientes conectados
        io.emit('message:new', testPayload);
        io.emit('whatsapp:new_message', testPayload);
        
        console.log('✅ [TEST SOCKET] Eventos emitidos para todos os clientes');
        
        res.json({ 
            success: true, 
            message: 'Evento emitido', 
            clientsConnected: io.engine?.clientsCount || 0,
            socketIds: sockets.map(([id]) => id),
            payload: testPayload 
        });
    } catch (error) {
        console.error('❌ [TEST SOCKET] Erro ao emitir:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 💬 Histórico de chat
router.get('/chat/:phone', whatsappController.getChat);

// 👥 CRUD de contatos
router.get('/contacts', whatsappController.listContacts);
router.post('/contacts', whatsappController.addContact);
router.put('/contacts/:id', whatsappController.updateContact);
router.delete('/contacts/:id', whatsappController.deleteContact);
router.post('/send-manual', whatsappController.sendManualMessage);
router.post('/amanda-resume/:leadId', whatsappController.amandaResume);
router.post('/amanda-pause/:leadId', whatsappController.amandaPause);
router.get('/contacts/search', whatsappController.contactsSearch);

export default router;

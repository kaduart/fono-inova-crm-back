import express from 'express';
import multer from 'multer';
import { whatsappController } from '../controllers/whatsappController.js';

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
router.post('/webhook', whatsappController.webhook);
router.get('/webhook', whatsappController.getWebhook);

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

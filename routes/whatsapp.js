import express from 'express';
import multer from 'multer';
import { whatsappController } from '../controllers/whatsappController.js';

const router = express.Router();

// Configuração do multer para upload de arquivos
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 16 * 1024 * 1024 // 16MB max (limite WhatsApp)
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
        
        console.log('📁 [Multer] Arquivo recebido:', file.originalname, 'tipo:', file.mimetype);
        
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

// 🎬 Envio de mídia
router.post('/upload-media', upload.single('file'), whatsappController.uploadMedia);
router.post('/send-media', upload.single('file'), whatsappController.sendMedia);

// 📩 Webhook
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

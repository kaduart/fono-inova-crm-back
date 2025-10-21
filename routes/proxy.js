// routes/proxy.js
import express from 'express';
import axios from 'axios';

const router = express.Router();

// 🔧 Rota GET para proxy de mídia do WhatsApp
router.get('/whatsapp-media', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        success: false,
        error: 'Parâmetro URL é obrigatório' 
      });
    }

    console.log('🔗 Proxy solicitado para URL:', url);

    // Faz a requisição usando axios
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity'
      }
    });

    // Obtém o content-type
    const contentType = response.headers['content-type'] || 'audio/ogg';
    
    console.log('✅ Proxy bem-sucedido:', {
      contentType: contentType,
      contentLength: response.data.length
    });

    // Define headers e envia resposta
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.send(response.data);

  } catch (error) {
    console.error('❌ Erro no proxy:', {
      message: error.message,
      url: req.query.url,
      status: error.response?.status
    });

    res.status(500).json({
      success: false,
      error: 'Falha ao carregar mídia',
      details: error.message,
      url: req.query.url
    });
  }
});

// Rota de teste simples
router.get('/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Proxy route is working!',
    timestamp: new Date().toISOString()
  });
});

export default router;
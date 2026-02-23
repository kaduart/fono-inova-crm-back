import Video from '../models/Video.js';
import { generateVideo as generateVideoService } from '../services/videoService.js';

export async function listVideos(req, res) {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: videos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function generateVideo(req, res) {
  try {
    const { especialidadeId, roteiro } = req.body;
    const video = new Video({
      title: `Vídeo ${especialidadeId}`,
      roteiro: roteiro || 'Gerando...',
      especialidadeId,
      status: 'processing'
    });
    await video.save();
    
    generateVideoService({ video, especialidadeId, roteiro }).catch(err => {
      console.error('Erro:', err);
      video.status = 'failed';
      video.save();
    });
    
    res.status(201).json({ success: true, data: video });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getVideoStatus(req, res) {
  try {
    const video = await Video.findById(req.params.id);
    res.json({ success: true, data: { status: video?.status } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function publishVideo(req, res) {
  try {
    const video = await Video.findById(req.params.id);
    video.publishedChannels = req.body.channels || [];
    video.publishedAt = new Date();
    await video.save();
    res.json({ success: true, data: video });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteVideo(req, res) {
  try {
    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

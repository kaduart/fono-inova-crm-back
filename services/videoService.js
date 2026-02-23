import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateVideo({ video, especialidadeId, roteiro }) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: `Gere roteiro para vídeo de 30s sobre ${especialidadeId}` }],
  });
  
  video.roteiro = roteiro || completion.choices[0].message.content;
  video.status = 'ready';
  video.videoUrl = 'https://example.com/video.mp4';
  await video.save();
  return video;
}

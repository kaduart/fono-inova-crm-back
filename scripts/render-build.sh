#!/bin/bash
# 🚀 Script de build para Render.com

echo "=========================================="
echo "🔧 Instalando dependências do sistema..."
echo "=========================================="

# Atualizar repositórios
apt-get update

# Instalar FFmpeg (ESSENCIAL para edição de vídeo)
echo "📹 Instalando FFmpeg..."
apt-get install -y ffmpeg
ffmpeg -version | head -1

# Instalar fontes (ESSENCIAL para legendas)
echo "🔤 Instalando fontes..."
apt-get install -y fonts-roboto fonts-dejavu fontconfig

# Se não conseguir instalar mscorefonts, usa DejaVu como fallback
apt-get install -y ttf-mscorefonts-installer || echo "⚠️  mscorefonts falhou, usando DejaVu"

# Atualizar cache de fontes
echo "🔄 Atualizando cache de fontes..."
fc-cache -f -v

# Listar fontes disponíveis
echo "✅ Fontes disponíveis:"
fc-list | grep -E "Roboto|DejaVu|Arial" | head -5

echo ""
echo "=========================================="
echo "📦 Instalando dependências Node.js..."
echo "=========================================="
npm install

echo ""
echo "=========================================="
echo "🎵 Configurando músicas..."
echo "=========================================="
# Criar links simbólicos ou copiar músicas se necessário
mkdir -p /tmp/pos_producao

echo ""
echo "✅ Build completo!"

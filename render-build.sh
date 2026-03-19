#!/bin/bash
# Script de build para Render - instala Chrome para Puppeteer

echo "🚀 Instalando Chrome..."

# Instala Chromium
apt-get update && apt-get install -y chromium-browser

# Define variável de ambiente
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

echo "✅ Chrome instalado!"

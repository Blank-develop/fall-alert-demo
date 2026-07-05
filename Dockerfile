# Hugging Face Docker Space — runs the Node alert server.
FROM node:20-alpine

WORKDIR /app

# Install prod deps first (better build caching).
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# HF Spaces route to port 7860 by default.
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]

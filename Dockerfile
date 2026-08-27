# Dspread CR100-SCRP web checkout + GxPay gateway integration.
# Runs the Express server (server.js) which serves the checkout UI from
# /public and exposes the /api/payments/* endpoints. Works for Render's
# Docker runtime as well as plain "docker run" / docker-compose.
FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY config ./config
COPY routes ./routes
COPY services ./services
COPY store ./store
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]

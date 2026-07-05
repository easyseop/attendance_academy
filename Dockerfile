# 학원 출석체크 서버
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME /app/data

CMD ["node", "src/server.js"]

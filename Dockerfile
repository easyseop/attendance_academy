# 학원 출석체크 서버
FROM node:22-slim

# SQLite의 datetime('now','localtime')이 시스템 시간대 정보를 사용하므로 tzdata 필요
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# 요일/시각 판정이 서버 시계 기준이므로 한국 시간대로 고정 (필요 시 TZ로 재정의)
ENV PORT=3000 DATA_DIR=/app/data TZ=Asia/Seoul
EXPOSE 3000
VOLUME /app/data

CMD ["node", "src/server.js"]

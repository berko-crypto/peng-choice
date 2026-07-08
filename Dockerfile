FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs build tools; canvas needs cairo/pango/jpeg/gif/rsvg
RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV DB_PATH=/app/data/faceoff.db

CMD ["node", "index.js"]

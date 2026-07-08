FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs build tools to compile its native binding
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Persist the DB outside the container layer
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/faceoff.db

CMD ["node", "index.js"]

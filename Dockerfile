# ---- שלב בנייה ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 עשוי להזדקק לקומפילציה אם אין בינארי מוכן
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# ---- שלב ריצה ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=80 \
    DATA_DIR=/app/data \
    TZ=Asia/Jerusalem

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

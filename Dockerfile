# OKB Media Collector — production image (no runtime dependencies beyond Node.js).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=8090
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist/src ./dist/src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM -> graceful shutdown (queue kept on /data).
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/index.js"]

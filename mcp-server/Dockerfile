# ── Stage 1: Build ──────────────────────────────────────────────────────────
# Node 22+ is required: recent @supabase/supabase-js initializes a Realtime
# client on createClient(), which needs a global WebSocket (built in on Node 22,
# absent on Node 20 → startup crash).
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/index.js"]

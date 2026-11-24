# ============================================================================
# PULSO AI (@pulso-ai/api) - Multi-Stage Production Dockerfile (Node 20 Alpine)
# Compatible con Railway, Render, Fly.io o VPS Docker
# ============================================================================

# Etapa 1: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY apps/api/package.json ./apps/api/

RUN npm install --workspace=@pulso-ai/api --include-workspace-root

COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src

RUN npm run build --workspace=@pulso-ai/api

# Etapa 2: Runtime ligero de Producción
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package.json ./
COPY apps/api/package.json ./apps/api/

RUN npm install --omit=dev --workspace=@pulso-ai/api --include-workspace-root && npm cache clean --force

COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]

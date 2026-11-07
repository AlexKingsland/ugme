# Social Wall — production image (Render runs this; any Docker host works).
# Two stages: build with all packages, then ship only what the server needs.

# ── build ────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

# Install from the lockfile (workspace package manifests first, for layer caching)
COPY package.json package-lock.json ./
COPY extensions/social-wall-pixel/package.json extensions/social-wall-pixel/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx prisma generate && npm run build

# Drop dev-only packages (Vite, TypeScript, …) before copying into the runtime image
RUN npm prune --omit=dev --no-audit --no-fund

# ── runtime ──────────────────────────────────────────────────────
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma

# Render sets PORT; remix-serve listens on it (3000 locally)
EXPOSE 3000
# Applies any new database migrations, then starts the server
CMD ["npm", "run", "docker-start"]

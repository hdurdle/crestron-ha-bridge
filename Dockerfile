FROM node:20-alpine AS deps
WORKDIR /app

# RUN apk add --no-cache tar curl

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Build the runtime image
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy node_modules from deps stage (cached), then app source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Optional: prune dev deps if you used npm ci with dev deps
# RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev

EXPOSE 8022
USER node
CMD ["npm","start"]
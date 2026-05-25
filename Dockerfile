# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --production

# Runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S proxy && adduser -S proxy -G proxy
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER proxy
EXPOSE 9090
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY backend/ ./backend/
COPY data/taxonomy/ ./data/taxonomy/
COPY scripts/build-standalone.mjs ./scripts/build-standalone.mjs
COPY index.html ./
COPY css/ ./css/
COPY js/ ./js/
RUN npm run build && npm prune --omit=dev

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 AWS_EC2_METADATA_DISABLED=true
WORKDIR /app
RUN groupadd --gid 101 martian && useradd --uid 101 --gid 101 --no-create-home martian
COPY --from=build /app/node_modules ./node_modules/
COPY --from=build /app/dist ./dist/
COPY --from=build /app/project-martian-standalone.html ./
COPY package.json package-lock.json index.html ./
COPY css/ ./css/
COPY js/ ./js/
COPY assets/ ./assets/
COPY db/ ./db/
# Initial import only. These files are never served as a static archive.
COPY data/records.json data/publication-seed.json ./data/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/backend/app.js"]

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ARG NODE_ENV=production
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --include=dev --strict-ssl=true && \
    npm run build && \
    npm prune --omit=dev && \
    mkdir -p /runtime/apps/web /runtime/data && \
    mv node_modules dist /runtime/ && \
    mv apps/web/dist /runtime/apps/web/ && \
    cp package.json /runtime/
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/fanvil.sqlite TZ=Europe/Rome
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/main.js"]

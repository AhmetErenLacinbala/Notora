FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps/web ./apps/web
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json ./
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data PYTHON_BIN=/opt/pdf/bin/python
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends qpdf python3 python3-venv ca-certificates \
    && python3 -m venv /opt/pdf \
    && /opt/pdf/bin/pip install --no-cache-dir pypdf==7.0.1 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY apps/server ./apps/server
COPY packages ./packages
RUN mkdir -p /data && chown node:node /data
ARG REVISION=development
ENV REVISION=$REVISION
LABEL org.opencontainers.image.title=Notora org.opencontainers.image.source=https://github.com/AhmetErenLacinbala/Notora org.opencontainers.image.revision=$REVISION
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]

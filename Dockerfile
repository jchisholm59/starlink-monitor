# Starlink Monitor in a container, for a host without Node or grpcurl (e.g. the cottage Frigate server).
FROM node:22-alpine
ARG GRPCURL_VERSION=1.9.3
ARG TARGETARCH
RUN apk add --no-cache curl && \
    arch=$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x86_64) && \
    curl -fsSL "https://github.com/fullstorydev/grpcurl/releases/download/v${GRPCURL_VERSION}/grpcurl_${GRPCURL_VERSION}_linux_${arch}.tar.gz" \
      | tar xz -C /usr/local/bin grpcurl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=7000
EXPOSE 7000
CMD ["node", "server.js"]

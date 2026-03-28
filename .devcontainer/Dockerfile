FROM node:24-alpine

RUN apk add --no-cache \
    git \
    bash \
    openssh-client \
    curl \
    jq \
    python3 \
    py3-pip \
    build-base \
    docker-cli \
    docker-cli-compose \
    ca-certificates

RUN npm install -g \
    typescript \
    eslint \
    prettier \
    vitest

WORKDIR /workspace

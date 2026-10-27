FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git expect zsh fish \
    && curl -fsSL "https://github.com/junegunn/fzf/releases/download/v0.74.2/fzf-0.74.2-linux_$(dpkg --print-architecture).tar.gz" \
    | tar -xz -C /usr/local/bin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json README.md LICENSE .npmignore ./
COPY bin ./bin
COPY lib ./lib
COPY test ./test
ENV TERM=xterm-256color GHQCD_E2E_REQUIRED=1
CMD ["npm", "test"]

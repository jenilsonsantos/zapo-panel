# Dockerfile do zapo-panel
#
# Build em dois estágios: o better-sqlite3 precisa compilar código nativo
# (node-gyp), então o 1º estágio instala Python + compiladores só para isso.
# A imagem final continua slim — ela apenas copia o node_modules já pronto.

FROM node:22-slim AS build

# Ferramentas que o node-gyp precisa para compilar o better-sqlite3
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala as dependências primeiro — assim o Docker reaproveita esta camada
# entre builds enquanto o package.json não mudar (build muito mais rápido).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Imagem final (sem compiladores, bem menor) ----
FROM node:22-slim

WORKDIR /app

# node_modules já compilado no estágio anterior
COPY --from=build /app/node_modules ./node_modules

# Copia o resto do projeto (o .dockerignore deixa node_modules e .auth de fora)
COPY . .

ENV PORT=3333
EXPOSE 3333

CMD ["node", "server.js"]

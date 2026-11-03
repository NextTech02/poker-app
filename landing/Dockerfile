# Landing page — HTML estático, gerado por idioma no build.
#
# Estágio 1: build.mjs aplica as traduções de i18n.js no index.html e gera uma
# página por idioma (/, /es/, /en/), o sitemap e os dados estruturados. É
# isso que o Google lê — por isso o texto sai pronto no HTML, e não traduzido
# pelo navegador.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY build.mjs index.html i18n.js ./
# robots.txt, 404.html e o que mais entrar (og.png, fontes). A pasta é
# versionada justamente para este COPY não falhar — `COPY` de diretório
# inexistente aborta o build.
COPY public/ public/
RUN node build.mjs

# Estágio 2: nginx:alpine e não `serve` (usado pelo frontend): aqui não há SPA
# para reescrever, e o nginx entrega arquivo estático com cache e gzip sem
# depender de Node em produção. A imagem final tem ~10 MB — o Node do
# estágio 1 não vai junto.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY seguranca.conf /etc/nginx/aceblind-seguranca.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/

EXPOSE 80

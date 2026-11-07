# Landing page — HTML estático, gerado por idioma no build.
#
# Estágio 1: build.mjs gera a home por idioma (/, /es/, /en/), as páginas
# internas de conteudo/, o sitemap e os dados estruturados. É isso que o Google
# lê — por isso o texto sai pronto no HTML, e não montado pelo navegador.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY build.mjs index.html i18n.js ./
# As páginas internas e o JavaScript das ferramentas grátis. Sem estas duas
# linhas o build para com erro: é ele que monta o site inteiro.
COPY conteudo/ conteudo/
COPY ferramentas/ ferramentas/
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

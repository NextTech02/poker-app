# Landing page — HTML estático, sem build.
#
# nginx:alpine e não `serve` (usado pelo frontend): aqui não há SPA para
# reescrever, e o nginx entrega arquivo estático com cache e gzip sem
# depender de Node em produção. A imagem final tem ~10 MB.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
# robots.txt, sitemap.xml e o que mais entrar (og.png, fontes). A pasta é
# versionada com esses dois arquivos justamente para este COPY não falhar —
# `COPY` de diretório inexistente aborta o build.
COPY public/ /usr/share/nginx/html/

EXPOSE 80

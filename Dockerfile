# syntax=docker/dockerfile:1
FROM nginx:1.30-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY index.html project-martian-standalone.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY data/ /usr/share/nginx/html/data/
COPY assets/ /usr/share/nginx/html/assets/
USER nginx
EXPOSE 8080
ENTRYPOINT []
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]

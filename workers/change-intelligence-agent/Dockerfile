FROM public.ecr.aws/docker/library/node:22.23.1-alpine3.23

RUN addgroup -S -g 10001 app \
  && adduser -S -D -H -u 10001 -G app app

WORKDIR /app
COPY dist/change-intelligence-agent/main.js /app/main.js

USER 10001:10001
ENTRYPOINT ["node", "/app/main.js"]

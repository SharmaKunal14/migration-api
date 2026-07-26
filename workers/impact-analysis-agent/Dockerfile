FROM public.ecr.aws/docker/library/node:22.23.1-alpine3.23

WORKDIR /app
COPY dist/workers/impact-analysis-agent/main.js /app/main.js

USER 10001:10001
ENTRYPOINT ["node", "/app/main.js"]

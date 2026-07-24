FROM node:22.14.0-alpine3.21 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY dist/workers/agent/main.js ./main.js

USER node

ENTRYPOINT ["node", "/app/main.js"]


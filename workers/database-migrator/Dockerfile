FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY dist/workers/database-migrator/main.js ./main.js
COPY supabase/migrations/*.sql ./migrations/

USER node

ENTRYPOINT ["node", "/app/main.js"]

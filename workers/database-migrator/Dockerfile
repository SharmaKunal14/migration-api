FROM node:22.14.0-alpine3.21 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY dist/workers/database-migrator/main.js ./main.js
COPY supabase/migrations/*.sql ./migrations/

USER node

ENTRYPOINT ["node", "/app/main.js"]


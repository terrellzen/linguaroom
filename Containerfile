FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:22-alpine
ENV NODE_ENV=production BIND=0.0.0.0 PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node docs/DEPENDENCIES.md ./DEPENDENCIES.md
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e 'const h=process.env.TLS_CERT?require("node:https"):require("node:http");const fs=require("node:fs");const port=process.env.PORT||3000;const options={host:"localhost",port,path:"/api/health",...(process.env.TLS_CERT?{ca:fs.readFileSync(process.env.TLS_CA||process.env.TLS_CERT)}:{})};h.get(options,r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'
CMD ["node","dist/apps/server/src/main.js"]

FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Asia/Jakarta

WORKDIR /app

COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile --production \
    && yarn cache clean

COPY src ./src

USER node

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]

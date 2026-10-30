# Hire box: Chromium + node + python + thin driver. The driver holds no
# brain and no secrets at rest — tools/files/browser only.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium python3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /home/hire/.chromium /app \
  && chown -R node:node /home/hire /app

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY driver.mjs ./

USER node
EXPOSE 8080
CMD ["node", "/app/driver.mjs"]

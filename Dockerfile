FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY lib ./lib
COPY mcp-server.js ./

RUN npm install --omit=dev

ENTRYPOINT ["node", "mcp-server.js"]

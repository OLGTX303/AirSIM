FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs rtp-pcm.mjs sip-udp.mjs ./
COPY public ./public
RUN mkdir -p /data/pki && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

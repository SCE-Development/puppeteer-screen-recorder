FROM node:20.10.0-alpine

WORKDIR /app


ENV CHROME_BIN="/usr/bin/chromium-browser"\
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true"

ENV PYTHONUNBUFFERED=1
RUN apk add --update --no-cache python3 && ln -sf python3 /usr/bin/python

RUN set -x \
    && apk update \
    && apk upgrade \
    # replacing default repositories with edge ones
    # && echo "http://dl-cdn.alpinelinux.org/alpine/edge/testing" > /etc/apk/repositories \
    # && echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories \
    # && echo "http://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories \
    # \
    # Add the packages
    && apk add --no-cache dumb-init curl make gcc g++ python3 linux-headers binutils-gold gnupg libstdc++ nss chromium ffmpeg \
    \
    && npm install puppeteer@0.13.0 \
    \
    # Do some cleanup
    && apk del --no-cache make gcc g++ python3 binutils-gold gnupg libstdc++ \
    && rm -rf /usr/include \
    && rm -rf /var/cache/apk/* /root/.node-gyp /usr/share/man /tmp/* \
    && echo

COPY package*.json ./

RUN npm install --omit=dev

RUN npm i ts-node

COPY tsconfig*.json ./

ARG WS4KP_URL

ARG WS4KP_ZIPCODE

ARG RTMP_MUSIC_STREAM_URL

ARG RTMP_OUTPUT_URL

CMD npm run start


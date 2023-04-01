FROM node:16-alpine

RUN apk add yarn

COPY nodejs /var/app

WORKDIR /var/app

RUN yarn install

CMD ["yarn", "start"]
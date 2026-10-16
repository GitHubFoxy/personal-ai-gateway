FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /home/node/.config/pag && chown -R node:node /home/node/.config/pag /app
USER node
ENV PAG_HOME=/home/node/.config/pag
ENV PAG_HOST=0.0.0.0
EXPOSE 4000
CMD ["node", "--experimental-strip-types", "src/cli.ts", "serve"]

# Imagen del servicio `api`. Node 24 porque el código usa `await` de módulo y
# el `fetch` global del runtime; alpine porque la imagen sólo tiene que correr
# un proceso.
FROM node:24-alpine

WORKDIR /app

# El manifiesto primero: mientras las dependencias no cambien, la capa de
# `npm ci` se reutiliza y reconstruir es cuestión de segundos.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Sólo lo que el servicio necesita para correr: ni tests, ni docs, ni el seed.
COPY --chown=node:node src ./src

ENV NODE_ENV=production
EXPOSE 3000

# El proceso corre como `node`, el usuario sin privilegios que la imagen oficial
# ya trae: un servicio que sólo lee su código y habla con Postgres no necesita
# root, y si algún día lo comprometen, el atacante no hereda la máquina. Los
# archivos se copian con `--chown=node:node` para que ese usuario pueda leerlos.
USER node

CMD ["node", "src/server.js"]

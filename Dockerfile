# Imagen del servicio `api`. Node 24 porque el código usa `await` de módulo y
# el `fetch` global del runtime; alpine porque la imagen sólo tiene que correr
# un proceso.
FROM node:24-alpine

WORKDIR /app

# El manifiesto primero: mientras las dependencias no cambien, la capa de
# `npm ci` se reutiliza y reconstruir es cuestión de segundos.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Sólo lo que el servicio necesita para correr: ni tests, ni docs, ni el seed.
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]

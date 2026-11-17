FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node numbers-server.js alfa-touch-numbers.html ./
RUN mkdir -p /data && chown node:node /data
ENV NUMBERS_HOST=0.0.0.0 NUMBERS_DATA_DIR=/data NUMBERS_PUBLIC=1
USER node
EXPOSE 8101
CMD ["node", "numbers-server.js"]

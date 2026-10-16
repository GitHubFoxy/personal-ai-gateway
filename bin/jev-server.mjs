#!/usr/bin/env node
import { createJevServer } from '../src/server.mjs';

const port = Number(process.env.JEV_PORT || 8787);
const host = process.env.JEV_HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('JEV_PORT must be an integer between 1 and 65535');
}
createJevServer().listen(port, host, () => {
  console.log('Jev Core listening at http://' + host + ':' + port);
});

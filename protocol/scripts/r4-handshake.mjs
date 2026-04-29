#!/usr/bin/env node
// R4 prototype — exercise the daemon WS handshake end-to-end.
//
// Goal: from "nothing" to a live WebSocket with the first `info` frame
// printed, in <100 lines, so M1 (Swift `ClayConnection` actor) has a
// known-good wire-level reference to copy.
//
// Usage:
//   node protocol/scripts/r4-handshake.mjs \
//     --url wss://localhost:2635/p/<slug>/ws \
//     [--pin 123456] \
//     [--insecure]   # skip TLS verification (mkcert dev certs)
//
// Exits 0 on receiving the first `info` frame, 1 otherwise.

import { WebSocket } from 'ws';
import https from 'node:https';
import http from 'node:http';

function parseArgs(argv) {
  const out = { url: null, pin: null, insecure: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--pin') out.pin = argv[++i];
    else if (a === '--insecure') out.insecure = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: r4-handshake.mjs --url wss://host:port/p/<slug>/ws [--pin 123456] [--insecure]');
      process.exit(0);
    }
  }
  if (!out.url) {
    console.error('error: --url is required');
    process.exit(2);
  }
  return out;
}

function authPostForCookie({ origin, pin, insecure }) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ pin });
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: '/auth',
        method: 'POST',
        rejectUnauthorized: !insecure,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`/auth → ${res.statusCode} ${Buffer.concat(chunks).toString()}`));
          }
          const setCookie = res.headers['set-cookie'] || [];
          const relay = setCookie.find((c) => c.startsWith('relay_auth='));
          if (!relay) return reject(new Error('/auth ok but no relay_auth cookie set'));
          // Strip attributes; keep only `name=value` for the request header.
          resolve(relay.split(';')[0]);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const wsUrl = new URL(args.url);
  const httpScheme = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
  const origin = `${httpScheme}//${wsUrl.host}`;

  let cookie = null;
  if (args.pin) {
    console.error(`[auth] POST ${origin}/auth (pin=${'*'.repeat(args.pin.length)})`);
    cookie = await authPostForCookie({ origin, pin: args.pin, insecure: args.insecure });
    console.error(`[auth] ok → ${cookie}`);
  } else {
    console.error('[auth] no --pin given; assuming daemon has no PIN configured');
  }

  console.error(`[ws] connecting ${args.url}`);
  const ws = new WebSocket(args.url, {
    headers: cookie ? { Cookie: cookie } : {},
    rejectUnauthorized: !args.insecure,
  });

  const timeout = setTimeout(() => {
    console.error('[ws] timed out waiting for info frame');
    ws.terminate();
    process.exit(1);
  }, 5000);

  ws.on('open', () => console.error('[ws] open'));
  ws.on('error', (e) => {
    console.error('[ws] error:', e.message);
    process.exit(1);
  });
  ws.on('close', (code, reason) => {
    console.error(`[ws] close ${code} ${reason?.toString() || ''}`);
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { console.error('[ws] non-JSON frame:', data.toString().slice(0, 200)); return; }
    console.log(JSON.stringify(msg, null, 2));
    if (msg.type === 'info') {
      clearTimeout(timeout);
      ws.close(1000, 'r4 prototype done');
      process.exit(0);
    }
  });
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

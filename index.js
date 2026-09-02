#!/usr/bin/env node

const os = require('os');
const http = require('http');
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const axios = require('axios');
const si = require('systeminformation');
const grpc = require('@grpc/grpc-js');
const { spawn } = require('child_process');
const protoLoader = require('@grpc/proto-loader');
const { WebSocket, createWebSocketStream } = require('ws');

// ========================== 环境变量配置 ==========================
const UUID = process.env.UUID || '';
const DOMAIN = process.env.DOMAIN || '';     
const SUB_PATH = process.env.SUB_PATH || '';           
const NAME = process.env.NAME || 'Vercel';                       
const PORT = process.env.PORT || 3000;                    

// NZ-Agent
const AGENT_VERSION = 'nodejs-9.9.9';
const REPORT_DELAY = 4;
const RETRY_DELAY = 10000;
const IP_REPORT_PERIOD = 1800;
const NETWORK_TIMEOUT = 8000;

// 日志控制 
const SHOW_LOG = !!(process.env.SHOW_LOG);
function log(...args) { if (SHOW_LOG) console.log(...args); }
function logErr(...args) { if (SHOW_LOG) console.error(...args); }
function logWarn(...args) { if (SHOW_LOG) console.warn(...args); }

// 辅助工具
const WSPATH = process.env.WSPATH || UUID.slice(0, 8); 
const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]); // NZ-TLS
let uuid = UUID.replace(/-/g, ""), CurrentDomain = DOMAIN, Tls = 'tls', CurrentPort = 443, ISP = '';
const DNS_SERVERS = ['8.8.4.4', '1.1.1.1'];
const BLOCKED_DOMAINS = ['testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org'];

//  TLS 检测
function shouldUseTLS(server) {
    const parts = server.split(':');
    if (parts.length < 2) return false;
    const port = parseInt(parts[parts.length - 1], 10);
    return TLS_PORTS.has(port);
}

// block speedtest domains
function isBlockedDomain(host) {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  return BLOCKED_DOMAINS.some(blocked => {
    return hostLower === blocked || hostLower.endsWith('.' + blocked);
  });
}

// 获取isp
async function getisp() {
  try {
    const res = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 }});
    const data = res.data;
    ISP = `${data.country_code}-${data.isp}`.replace(/ /g, '_');
  } catch (e) {
    try {
      const res2 = await axios.get('http://ip-api.com/json', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 }});
      const data2 = res2.data;
      ISP = `${data2.countryCode}-${data2.org}`.replace(/ /g, '_');
    } catch (e2) {
      ISP = 'Unknown';
    }
  }
}

// 获取ip
async function getip() {
  if (!DOMAIN || DOMAIN === 'your-domain.com') {
      try {
          const res = await axios.get('https://api-ipv4.ip.sb/ip', { timeout: 5000 });
          const ip = res.data.trim();
          CurrentDomain = ip, Tls = 'none', CurrentPort = PORT;
      } catch (e) {
          console.error('Failed to get IP', e.message);
          CurrentDomain = 'cahnge-your-domain.com', Tls = 'tls', CurrentPort = 443;
      }
  } else {
      CurrentDomain = DOMAIN, Tls = 'tls', CurrentPort = 443;
  }
}

// HTTP 路由
const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('Hello world!');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    });
    return;
  } else if (req.url === `/${SUB_PATH}`) {
    await getisp();await getip();
    const namePart = NAME ? `${NAME}-${ISP}` : ISP;
    const tlsParam = Tls === 'tls' ? 'tls' : 'none';
    const ssTlsParam = Tls === 'tls' ? 'tls;' : '';
    const vlsURL = `vless://${UUID}@${CurrentDomain}:${CurrentPort}?encryption=none&security=${tlsParam}&sni=${CurrentDomain}&fp=chrome&type=ws&host=${CurrentDomain}&path=%2F${WSPATH}#${namePart}`;
    const troURL = `trojan://${UUID}@${CurrentDomain}:${CurrentPort}?security=${tlsParam}&sni=${CurrentDomain}&fp=chrome&type=ws&host=${CurrentDomain}&path=%2F${WSPATH}#${namePart}`;
    const ssMethodPassword = Buffer.from(`none:${UUID}`).toString('base64');
    const ssURL = `ss://${ssMethodPassword}@${CurrentDomain}:${CurrentPort}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${CurrentDomain};path%3D%2F${WSPATH};${ssTlsParam}sni%3D${CurrentDomain};skip-cert-verify%3Dtrue;mux%3D0#${namePart}`;
    const subscription = vlsURL + '\n' + troURL + '\n' + ssURL;
    const base64Content = Buffer.from(subscription).toString('base64');

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(base64Content + '\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

// Custom DNS
function resolveHost(host) {
  return new Promise((resolve, reject) => {
    if (/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(host)) {
      resolve(host);
      return;
    }
    let attempts = 0;
    function tryNextDNS() {
      if (attempts >= DNS_SERVERS.length) {
        reject(new Error(`Failed to resolve ${host} with all DNS servers`));
        return;
      }
      const dnsServer = DNS_SERVERS[attempts];
      attempts++;
      const dnsQuery = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`;
      axios.get(dnsQuery, {
        timeout: 5000,
        headers: { 'Accept': 'application/dns-json' }
      })
        .then(response => {
          const data = response.data;
          if (data.Status === 0 && data.Answer && data.Answer.length > 0) {
            const ip = data.Answer.find(record => record.type === 1);
            if (ip) { resolve(ip.data); return; }
          }
          tryNextDNS();
        })
        .catch(error => { tryNextDNS(); });
    }
    tryNextDNS();
  });
}

// Tro-jan处理
function handleTrojConnection(ws, msg) {
  try {
    if (msg.length < 58) return false;
    const receivedPasswordHash = msg.slice(0, 56).toString();
    const possiblePasswords = [UUID];
    let matchedPassword = null;
    for (const pwd of possiblePasswords) {
      const hash = crypto.createHash('sha224').update(pwd).digest('hex');
      if (hash === receivedPasswordHash) { matchedPassword = pwd; break; }
    }
    if (!matchedPassword) return false;
    let offset = 56;
    if (msg[offset] === 0x0d && msg[offset + 1] === 0x0a) offset += 2;
    const cmd = msg[offset];
    if (cmd !== 0x01) return false;
    offset += 1;
    const atyp = msg[offset];
    offset += 1;
    let host, port;
    if (atyp === 0x01) {
      host = msg.slice(offset, offset + 4).join('.'); offset += 4;
    } else if (atyp === 0x03) {
      const hostLen = msg[offset]; offset += 1;
      host = msg.slice(offset, offset + hostLen).toString(); offset += hostLen;
    } else if (atyp === 0x04) {
      host = msg.slice(offset, offset + 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':'); offset += 16;
    } else { return false; }
    port = msg.readUInt16BE(offset); offset += 2;
    if (offset < msg.length && msg[offset] === 0x0d && msg[offset + 1] === 0x0a) offset += 2;
    if (isBlockedDomain(host)) { ws.close(); return false; }
    const duplex = createWebSocketStream(ws);
    resolveHost(host)
      .then(resolvedIP => {
        net.connect({ host: resolvedIP, port }, function () {
          if (offset < msg.length) this.write(msg.slice(offset));
          duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { });
      })
      .catch(error => {
        net.connect({ host, port }, function () {
          if (offset < msg.length) this.write(msg.slice(offset));
          duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { });
      });
    return true;
  } catch (error) { return false; }
}

// Ws handler
const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', (ws, req) => {
  const url = req.url || '';
  const expectedPath = `/${WSPATH}`;
  if (!url.startsWith(expectedPath)) { ws.close(); return; }

  ws.once('message', msg => {
    if (msg.length > 17 && msg[0] === 0) {
      const id = msg.slice(1, 17);
      const isVless = id.every((v, i) => v == parseInt(uuid.substr(i * 2, 2), 16));
      if (isVless) { if (!handleVlsConnection(ws, msg)) ws.close(); return; }
    }
    if (msg.length >= 58) { if (handleTrojConnection(ws, msg)) return; }
    if (msg.length > 0 && (msg[0] === 0x01 || msg[0] === 0x03 || msg[0] === 0x04)) {
      if (handleSsConnection(ws, msg)) return;
    }
    ws.close();
  }).on('error', () => { });
});

// start service
httpServer.listen(PORT, () => {
  startNezhaAgent().catch(err => console.error('error', err));
  console.log(`Server is running on ${PORT}`);
});

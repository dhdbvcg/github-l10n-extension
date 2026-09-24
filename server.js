/* 本地测试服务器：以 CORS + Private Network Access 方式静态服务扩展目录，供浏览器页面注入脚本用 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const types = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath === '/' ? '/index.html' : urlPath);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, corsHeaders);
      res.end('not found');
      return;
    }
    res.writeHead(200, { ...corsHeaders, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(18765, '127.0.0.1', () => console.log('serving on http://127.0.0.1:18765'));

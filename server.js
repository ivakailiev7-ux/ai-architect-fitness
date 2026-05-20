const http = require('http');
const fs = require('fs');
const path = require('path');
const dir = __dirname;
http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url;
  const fp = path.join(dir, file);
  const ext = path.extname(fp);
  const types = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': types[ext] || 'text/plain'});
    res.end(data);
  });
}).listen(3000, () => console.log('Server running on port 3000'));

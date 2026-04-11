import http from 'http';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

// DB Setup
const dbDir = path.join(REPO_ROOT, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'ollama_logs.db');
const db = new Database(dbPath);

console.log(`Setting up database at ${dbPath}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    endpoint TEXT,
    model TEXT,
    prompt TEXT,
    response TEXT,
    duration_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO requests (endpoint, model, prompt, response, duration_ms, prompt_tokens, completion_tokens)
  VALUES (@endpoint, @model, @prompt, @response, @duration_ms, @prompt_tokens, @completion_tokens)
`);

const PROXY_PORT = 11435;
const OLLAMA_PORT = 11434;

// Function to recursively strip large images from JSON request
function stripImages(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripImages);
  if (obj !== null && typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      if (key === 'images' && Array.isArray(obj[key])) {
        newObj[key] = ['[BASE64_IMAGE_STRIPPED]'];
      } else {
        newObj[key] = stripImages(obj[key]);
      }
    }
    return newObj;
  }
  return obj;
}

const server = http.createServer((req, res) => {
  // CORS setup for web interface if needed
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Simple UI Dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ui')) {
    let logs = [];
    try {
      logs = db.prepare('SELECT * FROM requests ORDER BY timestamp DESC LIMIT 50').all();
    } catch (e) {
      console.error(e);
    }
    
    // UI HTML generator
    res.writeHead(200, { 'Content-Type': 'text/html' });
    let html = `<html><head><title>Ollama Proxy Log</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; margin: 0; }
      .container { max-width: 1200px; margin: 0 auto; }
      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
      .log-card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; border: 1px solid #334155; }
      .meta { display: flex; gap: 1rem; margin-bottom: 1rem; font-size: 0.9rem; color: #94a3b8; }
      .badge { background: #3b82f6; color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600; }
      .pre { background: #0b0f19; padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; font-family: monospace; font-size: 0.85rem;}
      .stats { display: flex; gap: 1rem; font-size: 0.85rem; color: #10b981; margin-top: 1rem; font-weight: bold;}
    </style></head><body><div class="container">
    <div class="header">
      <h1>Ollama Local Observability</h1>
      <span>Port: ${PROXY_PORT} &rarr; Target: ${OLLAMA_PORT}</span>
    </div>`;
    
    if (logs.length === 0) {
      html += `<p style="text-align: center; margin-top: 4rem; color: #94a3b8;">No requests logged yet. Start querying http://localhost:${PROXY_PORT} !</p>`;
    }

    for (const log of logs as any[]) {
      html += `<div class="log-card">
        <div class="meta">
          <span class="badge">${log.model || 'Unknown'}</span>
          <span>${log.endpoint}</span>
          <span>${log.timestamp}</span>
        </div>
        <strong>Prompt:</strong>
        <div class="pre">${log.prompt}</div>
        <strong>Response:</strong>
        <div class="pre">${log.response}</div>
        <div class="stats">
          <span>Latency: ${log.duration_ms ? log.duration_ms + ' ms' : 'N/A'}</span>
          <span>Prompt Tokens: ${log.prompt_tokens || '0'}</span>
          <span>Completion Tokens: ${log.completion_tokens || '0'}</span>
        </div>
      </div>`;
    }
    
    html += `</div></body></html>`;
    return res.end(html);
  }

  // Handle HTTP endpoint checks
  if (req.method === 'GET' && req.url !== '/' && req.url !== '/ui') {
     const options = {
        hostname: 'localhost',
        port: OLLAMA_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers
      };
      const proxyReq = http.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => { res.writeHead(502); res.end('Proxy Error'); });
      proxyReq.end();
      return;
  }

  // Handle Proxy API calls (mostly POSTs)
  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk.toString());
    req.on('end', () => {
      let parsedBody: any = {};
      let model = 'unknown';
      let promptText = '';
      
      try {
        parsedBody = JSON.parse(rawBody);
        model = parsedBody.model || 'unknown';
        const strippedBody = stripImages(parsedBody);
        promptText = JSON.stringify(strippedBody, null, 2);
      } catch(e) {
        promptText = rawBody;
      }

      const options = {
        hostname: 'localhost',
        port: OLLAMA_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `localhost:${OLLAMA_PORT}`
        }
      };

      const startMs = Date.now();

      const proxyReq = http.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        
        let responseBuffer = '';
        
        proxyRes.on('data', chunk => {
          res.write(chunk);
          responseBuffer += chunk.toString();
        });
        
        proxyRes.on('end', () => {
          res.end();
          
          let finalResponseText = '';
          let totalDuration = Date.now() - startMs;
          let promptTokens = 0;
          let completionTokens = 0;
          
          try {
            // Check if response is NDJSON (streaming) or plain JSON
            if (responseBuffer.includes('\\n') && !responseBuffer.startsWith('{')) {
               const lines = responseBuffer.trim().split('\\n');
               for (const line of lines) {
                  if(!line.trim()) continue;
                  try {
                    const parsed = JSON.parse(line);
                    if (parsed.response) finalResponseText += parsed.response;
                    if (parsed.message?.content) finalResponseText += parsed.message.content; // chat API
                    
                    if (parsed.done === true) {
                       if (parsed.total_duration) totalDuration = Math.round(parsed.total_duration / 1000000); // ns to ms
                       if (parsed.prompt_eval_count) promptTokens = parsed.prompt_eval_count;
                       if (parsed.eval_count) completionTokens = parsed.eval_count;
                       
                       // Catch OpenAI compatible completions in Ollama
                       if (parsed.usage) {
                          promptTokens = parsed.usage.prompt_tokens || promptTokens;
                          completionTokens = parsed.usage.completion_tokens || completionTokens;
                       }
                    }
                  } catch(ex) { /* skip unparseable */ }
               }
            } else {
               // Normal JSON
               const parsed = JSON.parse(responseBuffer);
               if (parsed.response) finalResponseText = parsed.response;
               else if (parsed.message?.content) finalResponseText = parsed.message.content;
               else if (parsed.choices && parsed.choices[0]?.message) finalResponseText = parsed.choices[0].message.content;
               
               if (parsed.eval_count) completionTokens = parsed.eval_count;
               if (parsed.prompt_eval_count) promptTokens = parsed.prompt_eval_count;
               if (parsed.total_duration) totalDuration = Math.round(parsed.total_duration / 1000000);
               
               if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || promptTokens;
                  completionTokens = parsed.usage.completion_tokens || completionTokens;
               }
            }
          } catch(e) {
            finalResponseText = responseBuffer;
          }
          
          if (!finalResponseText && responseBuffer) {
              finalResponseText = responseBuffer;
          }

          try {
            insertStmt.run({
              endpoint: req.url,
              model: model,
              prompt: promptText,
              response: finalResponseText,
              duration_ms: totalDuration,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens
            });
          } catch (dbErr) {
            console.error('DB Insert Error:', dbErr);
          }
        });
      });

      proxyReq.on('error', err => {
        console.error('Proxy Request Error:', err);
        res.writeHead(502);
        res.end(JSON.stringify({ error: "Failed to reach Ollama", details: err.message }));
      });

      proxyReq.write(rawBody);
      proxyReq.end();
    });
  }
});

server.listen(PROXY_PORT, () => {
  console.log(`\x1b[32m[+] Ollama Proxy started on http://localhost:${PROXY_PORT}\x1b[0m`);
  console.log(`\x1b[36m[i] Dashboard UI available at http://localhost:${PROXY_PORT}/ui\x1b[0m`);
});

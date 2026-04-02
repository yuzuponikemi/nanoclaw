/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

function extractUsage(
  body: string,
): { model: string; inputTokens: number; outputTokens: number } | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let model = '';

  // Try SSE format first (streaming responses)
  if (body.includes('event:') || body.includes('data:')) {
    for (const line of body.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'message_start' && data.message) {
          inputTokens = data.message.usage?.input_tokens ?? 0;
          model = data.message.model ?? '';
        }
        if (data.type === 'message_delta' && data.usage) {
          outputTokens = data.usage.output_tokens ?? 0;
        }
      } catch {
        /* skip non-JSON lines */
      }
    }
  }

  // Try JSON format (non-streaming responses)
  if (inputTokens === 0) {
    try {
      const json = JSON.parse(body);
      if (json.usage) {
        inputTokens = json.usage.input_tokens ?? 0;
        outputTokens = json.usage.output_tokens ?? 0;
        model = json.model ?? '';
      }
    } catch {
      /* not JSON */
    }
  }

  return inputTokens > 0 ? { model, inputTokens, outputTokens } : null;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  onUsage?: (entry: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    requestPath: string;
  }) => void,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);

            const isMessagesEndpoint = req.url?.includes('/v1/messages');

            if (!isMessagesEndpoint || !onUsage) {
              upRes.pipe(res);
              return;
            }

            // Intercept for usage tracking
            const responseChunks: Buffer[] = [];
            upRes.on('data', (chunk: Buffer) => {
              responseChunks.push(chunk);
              res.write(chunk);
            });
            upRes.on('end', () => {
              res.end();
              // Parse usage from response (SSE or JSON)
              try {
                const responseBody =
                  Buffer.concat(responseChunks).toString('utf8');
                const usage = extractUsage(responseBody);
                if (usage && onUsage) {
                  try {
                    onUsage({
                      ...usage,
                      requestPath: req.url ?? '/v1/messages',
                    });
                  } catch (err) {
                    logger.debug({ err }, 'onUsage callback threw');
                  }
                }
              } catch (err) {
                logger.debug({ err }, 'Failed to parse usage from response');
              }
            });
            upRes.on('error', (err) => {
              logger.debug({ err }, 'Response stream error');
            });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

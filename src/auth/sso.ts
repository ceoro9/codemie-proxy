import http from 'http';
import net from 'net';
import { exec } from 'child_process';
import { config } from '../config';
import type { SSOStore } from '../types';

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32'  ? `start "" "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn('  Browser could not be opened automatically.');
      console.warn('  Open the URL above in your browser to complete login.\n');
      if (!config.ssoCallbackPort) {
        console.warn('  Running in Docker? Set CODEMIE_SSO_CALLBACK_PORT=<port> and');
        console.warn('  publish that port with -p <port>:<port> so the browser redirect');
        console.warn('  can reach the container. Example:');
        console.warn('    docker run -p 9090:9090 -p 9091:9091 \\');
        console.warn('      -e CODEMIE_SSO_CALLBACK_PORT=9091 ...\n');
      }
    }
  });
}

export function ssoLogin(): Promise<SSOStore> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://localhost');
      const tokenB64 = parsed.searchParams.get('token');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="font-family:sans-serif;padding:2rem">' +
        '<h2>&#10003; Authentication successful</h2>' +
        '<p>You can close this tab.</p></body></html>',
      );
      server.close();

      if (!tokenB64) {
        reject(new Error('No token param in SSO callback'));
        return;
      }

      try {
        // Token is base64-encoded JSON: { cookies: { name: value, ... } }
        const decoded = JSON.parse(Buffer.from(tokenB64, 'base64').toString('utf-8')) as {
          cookies: Record<string, string>;
        };
        resolve({
          cookies: decoded.cookies ?? {},
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
      } catch (e) {
        reject(new Error(`Failed to decode SSO token: ${e}`));
      }
    });

    server.listen(config.ssoCallbackPort, () => {
      const port = (server.address() as net.AddressInfo).port;
      const loginUrl = `${config.serverUrl}/v1/auth/login/${port}`;
      console.log('\n  ── SSO login required ───────────────────────────────────');
      console.log(`\n  ${loginUrl}\n`);
      console.log('  Open the URL above in your browser. Waiting 60 s…');
      console.log('  ─────────────────────────────────────────────────────────\n');
      openBrowser(loginUrl);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('SSO login timed out after 60 s'));
    }, 60_000);

    server.on('close', () => clearTimeout(timer));
  });
}

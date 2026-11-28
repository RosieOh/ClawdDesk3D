// Serves a local voice pack at /voicepack/* from the dev and preview servers, without ever bundling it.
// Root: $CLAWDDESK_VOICEPACK, else <repo>/voicepack (gitignored). Paths that escape the root are refused;
// symlinks inside the root are followed (point one at wherever your recordings live).

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const PREFIX = '/voicepack/';
const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

/** Absolute file for a request URL under `root`, or null (not ours / escapes root / not allowed type). */
export function resolveVoicepackPath(url: string | undefined, root: string): string | null | 'forbidden' {
  if (!url || !url.startsWith(PREFIX)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(url.slice(PREFIX.length).split(/[?#]/)[0]);
  } catch {
    return 'forbidden';
  }
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep) || rel.includes('\0')) return 'forbidden';
  if (!(path.extname(file).toLowerCase() in TYPES)) return 'forbidden';
  return file;
}

export function voicepackPlugin(root: string): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const file = resolveVoicepackPath(req.url, root);
    if (file === null) return next();
    if (file === 'forbidden') {
      res.statusCode = 403;
      return res.end();
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()]);
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(file).pipe(res);
    });
  };
  return {
    name: 'clawddesk-voicepack',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

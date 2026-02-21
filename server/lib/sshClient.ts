/**
 * sshClient — Reusable SSH helper for the Remote Orchestration layer.
 *
 * Wraps the `ssh2` library with two operation modes:
 *   openConnection()  — Establish an authenticated SSH session.
 *   runCommand()      — Collect stdout/stderr and return when the command exits.
 *   streamCommand()   — Pipe stdout/stderr to an Express SSE response in real time.
 *
 * Connection credentials are never logged.
 */

import { readFileSync } from 'fs';
import { Client, type ConnectConfig } from 'ssh2';
import type { Response } from 'express';

export interface SSHConnectOpts {
  host:       string;
  port?:      number;       // default 22
  username:   string;
  /** Path to a private key file on the bridge host, OR the raw PEM string. */
  privateKey?: string;
  /** Plaintext password (only when key is not provided). */
  password?:  string;
  /** TCP + auth timeout in ms. */
  connectTimeout?: number;
}

export interface RunResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
}

/** Open a connected Client. Caller must call conn.end() when done. */
export function openConnection(opts: SSHConnectOpts): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    const cfg: ConnectConfig = {
      host:         opts.host,
      port:         opts.port ?? 22,
      username:     opts.username,
      readyTimeout: opts.connectTimeout ?? 10_000,
    };

    if (opts.privateKey) {
      // Accept either a raw PEM string or a file path
      const isPem = opts.privateKey.trimStart().startsWith('-----BEGIN');
      if (isPem) {
        cfg.privateKey = opts.privateKey;
      } else {
        try {
          cfg.privateKey = readFileSync(opts.privateKey, 'utf-8');
        } catch (e) {
          reject(new Error(`Cannot read SSH key file "${opts.privateKey}": ${String(e)}`));
          return;
        }
      }
    } else if (opts.password) {
      cfg.password = opts.password;
    } else {
      reject(new Error('Either privateKey or password must be provided'));
      return;
    }

    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(err));
    conn.connect(cfg);
  });
}

/** Run a command and collect its output. */
export function runCommand(conn: Client, cmd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) { reject(err); return; }

      let stdout = '';
      let stderr = '';

      stream.on('data', (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      stream.on('close', (code: number) => {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
      });
    });
  });
}

/**
 * Run a long-running command and stream each output line to an SSE response.
 * Emits:
 *   data: {"type":"stdout","line":"..."}
 *   data: {"type":"stderr","line":"..."}
 *   data: {"type":"exit","code":"0"}
 */
export function streamCommand(conn: Client, cmd: string, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) { reject(err); return; }

      const emit = (type: string, line: string) =>
        res.write(`data: ${JSON.stringify({ type, line })}\n\n`);

      const pipeStream = (src: NodeJS.ReadableStream, type: 'stdout' | 'stderr') => {
        let buf = '';
        src.on('data', (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const l of lines) if (l) emit(type, l);
        });
        src.on('end', () => { if (buf) { emit(type, buf); buf = ''; } });
      };

      pipeStream(stream,        'stdout');
      pipeStream(stream.stderr, 'stderr');

      stream.on('close', (code: number) => { emit('exit', String(code ?? 0)); resolve(); });
      stream.on('error', reject);
    });
  });
}

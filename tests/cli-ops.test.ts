import { describe, expect, it } from 'vitest';
import {
  runDbStats,
  runHealth,
  runIndexStatus,
  runLogsTail,
  runPoiLatest,
  runPoiPending,
  runRpcStatus,
} from '../cli/src/ops.js';
import type { CliIo } from '../cli/src/index.js';

class CapturedIo implements CliIo {
  stdoutBuf = '';
  stderrBuf = '';
  cwd = process.cwd();
  stdout = { write: (s: string): boolean => ((this.stdoutBuf += s), true) };
  stderr = { write: (s: string): boolean => ((this.stderrBuf += s), true) };
}

function fetchStatus(body: unknown, status = 200) {
  return async () => ({
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

function pool(rows: Array<Record<string, unknown>>) {
  return () => ({
    query: async () => ({ rows }),
    end: async () => {},
  });
}

describe('operator CLI commands', () => {
  it('health reads hosted /status and supports text output', async () => {
    const io = new CapturedIo();
    const code = await runHealth(
      ['--node', 'https://api.example.test'],
      io,
      fetchStatus({
        status: 'ok',
        environment: 'testnet',
        network: 'kaspa-testnet-10',
        rpcConnected: 'unavailable',
        postgresConnected: true,
        version: '0.1.0',
      }),
    );
    expect(code).toBe(0);
    expect(io.stdoutBuf).toContain('API health: ok');
    expect(io.stdoutBuf).toContain('Network: kaspa-testnet-10');
  });

  it('index status supports json output from hosted /status', async () => {
    const io = new CapturedIo();
    const code = await runIndexStatus(
      ['--node', 'https://api.example.test', '--json'],
      io,
      fetchStatus({ indexedDaaScore: '10', indexedBlocks: 2 }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.stdoutBuf)).toEqual({ indexedDaaScore: '10', indexedBlocks: 2 });
  });

  it('poi latest reads the latest database checkpoint', async () => {
    const io = new CapturedIo();
    const code = await runPoiLatest(
      ['--database-url', 'postgres://x', '--json'],
      io,
      pool([{ subgraph: 'network_stats', daa_score: '10', checkpoint_hash: '0xabc' }]),
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.stdoutBuf)).toEqual({
      subgraph: 'network_stats',
      daaScore: '10',
      checkpointHash: '0xabc',
    });
  });

  it('db stats returns database counts', async () => {
    const io = new CapturedIo();
    const code = await runDbStats(
      ['--database-url', 'postgres://x', '--json'],
      io,
      pool([{ stats: { committedBlocks: 3, poiCheckpoints: 1 } }]),
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.stdoutBuf)).toEqual({ committedBlocks: 3, poiCheckpoints: 1 });
  });

  it('rpc status surfaces public RPC status from /status', async () => {
    const io = new CapturedIo();
    const code = await runRpcStatus(
      ['--node', 'https://api.example.test'],
      io,
      fetchStatus({ rpcConnected: 'unavailable', network: 'kaspa-testnet-10' }),
    );
    expect(code).toBe(0);
    expect(io.stdoutBuf).toContain('RPC connected: unavailable');
  });

  it('pending commands fail explicitly instead of pretending to work', async () => {
    const io1 = new CapturedIo();
    expect(await runPoiPending('verify', [], io1)).toBe(64);
    expect(io1.stderrBuf).toContain('pending');

    const io2 = new CapturedIo();
    expect(await runLogsTail([], io2)).toBe(64);
    expect(io2.stderrBuf).toContain('pending');
  });
});

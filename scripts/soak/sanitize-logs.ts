import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { sanitizeLogLine, sanitizeLogText } from '../../api/src/log-sanitize.js';

export { sanitizeLogLine, sanitizeLogText };

export async function sanitizeLogFile(inputPath: string, outputPath: string): Promise<void> {
  const input = createReadStream(inputPath, { encoding: 'utf8' });
  const output = createWriteStream(outputPath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    output.write(`${sanitizeLogLine(line)}\n`);
  }

  await new Promise<void>((resolve, reject) => {
    output.end(resolve);
    output.on('error', reject);
  });
}

async function main(): Promise<void> {
  const [, , inputPath, outputPath] = process.argv;
  if (inputPath === undefined || outputPath === undefined) {
    process.stderr.write('usage: sanitize-logs.ts <input-log> <output-log>\n');
    process.exitCode = 64;
    return;
  }
  await sanitizeLogFile(inputPath, outputPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

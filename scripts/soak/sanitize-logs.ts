import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const REDACTION = '[REDACTED]';

const secretKeyPattern =
  /\b(?:DATABASE_URL|KASGRAPH_DATABASE_URL|KASGRAPH_DEPLOY_TOKEN|KASGRAPH_RPC_PRIMARY_URL|KASGRAPH_RPC_BACKUP_URLS|KASGRAPH_NOTIFICATION_WS_URL|LISTEN_DATABASE_URL|API_KEY|ACCESS_TOKEN|SECRET|TOKEN|PASSWORD|PASS|PRIVATE_KEY)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi;

const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const connectionStringPattern =
  /\b(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^\s"'<>]+/gi;
const urlWithCredentialPattern = /\b(?:https?|wss?):\/\/[^/\s"'<>:@]+:[^@\s"'<>]+@[^\s"'<>]+/gi;
const obviousCredentialPattern =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const privateRpcPattern =
  /\b(?:https?|wss?):\/\/[^\s"'<>]*(?:token|key|secret|password|apikey|auth)[^\s"'<>]*/gi;
const ipv4Pattern =
  /\b(?:(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}|(?:\d{1,3}\.){3}\d{1,3})\b/g;
const homePathPattern = /(?:\/home|\/Users)\/[^\s"'<>]+/g;

export function sanitizeLogLine(line: string): string {
  return line
    .replace(secretKeyPattern, (match) => redactAssignment(match))
    .replace(obviousCredentialPattern, (match) => redactAssignment(match))
    .replace(bearerPattern, `Bearer ${REDACTION}`)
    .replace(connectionStringPattern, REDACTION)
    .replace(urlWithCredentialPattern, REDACTION)
    .replace(privateRpcPattern, REDACTION)
    .replace(ipv4Pattern, REDACTION)
    .replace(homePathPattern, REDACTION);
}

export function sanitizeLogText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => sanitizeLogLine(line))
    .join('\n');
}

function redactAssignment(match: string): string {
  const idx = match.search(/[:=]/);
  if (idx === -1) return REDACTION;
  return `${match.slice(0, idx + 1)}${REDACTION}`;
}

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

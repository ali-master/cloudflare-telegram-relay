import {chmod, cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';

/** Read the dashboard login key without exposing its value in validation errors. */
async function readAdminKey() {
  let key = process.env.RELAY_API_KEY;
  if (process.env.RELAY_API_KEY_FILE) {
    try {
      key = (await readFile(process.env.RELAY_API_KEY_FILE, 'utf8')).trim();
    } catch {
      throw new Error('Cannot read RELAY_API_KEY_FILE; check the mounted file and its permissions');
    }
  }
  if (!key || key.length < 16 || key.length > 1024 || /[\r\n\x00-\x1f\x7f]/.test(key)) {
    throw new Error('Provide RELAY_API_KEY_FILE or RELAY_API_KEY with a single-line admin key of 16 to 1024 characters');
  }
  return key;
}

/** Keep deployment diagnostics useful without printing the supplied credentials. */
function forwardRedactedLogs(stream, destination, secrets) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discarding = false;

  /** Remove credential values from a complete diagnostic line. */
  function writeLine(line) {
    for (const secret of secrets) line = line.replaceAll(secret, '[redacted]');
    destination.write(line);
  }

  /** Buffer across process-output chunks so split credentials remain redacted. */
  function consume(chunk) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline + 1);
      if (!discarding && line.length <= 65536) writeLine(line);
      else destination.write('[oversized deployment diagnostic omitted]\n');
      pending = pending.slice(newline + 1);
      discarding = false;
    }
    if (pending.length > 65536) {
      pending = '';
      discarding = true;
    }
  }

  stream.on('data', chunk => consume(decoder.write(chunk)));
  stream.on('end', () => {
    consume(decoder.end());
    if (discarding) destination.write('[oversized deployment diagnostic omitted]\n');
    else if (pending) writeLine(pending);
  });
}

/** Publish one application release and admin binding into the fleet's durable bucket. */
async function publish() {
  const key = await readAdminKey();
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-celld-publish-'));
  const secrets = [...new Set([
    key,
    JSON.stringify(key).slice(1, -1),
    process.env.AWS_ACCESS_KEY_ID,
    process.env.AWS_SECRET_ACCESS_KEY,
    process.env.AWS_SESSION_TOKEN,
  ].filter(Boolean))].sort((left, right) => right.length - left.length);
  let child;
  let interrupted;

  /** Let celld terminate before removing its temporary deployment files. */
  function terminate(signal) {
    interrupted = signal;
    child?.kill(signal);
  }

  const onTerminate = () => terminate('SIGTERM');
  const onInterrupt = () => terminate('SIGINT');
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  try {
    await cp('/app/bundle', directory, {recursive: true});
    const configPath = path.join(directory, 'wrangler.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.vars = {...config.vars, API_KEY: key};
    await writeFile(configPath, `${JSON.stringify(config)}\n`, {mode: 0o600});
    await chmod(configPath, 0o600);
    if (interrupted) {
      process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
      return;
    }

    // The deployed vars remain in the bucket. Deleting this temporary file does
    // not remove that copy; bucket access must be treated as secret access.
    const childEnvironment = {...process.env};
    delete childEnvironment.RELAY_API_KEY;
    delete childEnvironment.RELAY_API_KEY_FILE;
    process.exitCode = await new Promise((resolve, reject) => {
      child = spawn('celld', ['deploy', directory, ...process.argv.slice(2)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment,
      });
      forwardRedactedLogs(child.stdout, process.stdout, secrets);
      forwardRedactedLogs(child.stderr, process.stderr, secrets);
      child.once('error', () => reject(new Error('Could not start celld deployment')));
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    await rm(directory, {recursive: true, force: true});
  }
}

publish().catch(error => {
  // Never include configuration contents or a child environment in errors.
  console.error(`Publication failed: ${error.message}`);
  process.exitCode = 1;
});

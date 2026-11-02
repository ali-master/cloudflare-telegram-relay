import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {parse, printParseErrorCode} from 'jsonc-parser';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.env.RELAY_BUILD_OUTPUT || '/app/bundle');
const errors = [];
const original = parse(await readFile(path.join(project, 'wrangler.jsonc'), 'utf8'), errors, {allowTrailingComma: true});
if (errors.length) throw new Error(`Invalid Wrangler configuration: ${errors.map(e => printParseErrorCode(e.error)).join(', ')}`);

// Fail on new bindings/options until their celld behavior has been reviewed.
const kept = new Set(['name', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'vars']);
const handled = new Set(['$schema', 'main', 'assets', 'secrets', 'observability', 'upload_source_maps', 'placement']);
for (const key of Object.keys(original)) {
  if (!kept.has(key) && !handled.has(key)) throw new Error(`Review celld compatibility before adding configuration key: ${key}`);
}
const entry = original.main;
if (typeof entry !== 'string' || !entry || path.isAbsolute(entry)
    || path.relative(project, path.resolve(project, entry)).startsWith('..')) {
  throw new Error('Wrangler main must identify an entrypoint inside the project');
}
await mkdir(output, {recursive: true});
await build({
  absWorkingDir: project,
  entryPoints: [entry],
  outfile: path.join(output, 'worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['cloudflare:*', 'node:*'],
  sourcemap: false,
  logLevel: 'warning',
});
const config = Object.fromEntries(Object.entries(original).filter(([key]) => kept.has(key)));
config.main = 'worker.js';
config.no_bundle = true;
if (original.assets) {
  await cp(path.resolve(project, original.assets.directory), path.join(output, 'public'), {recursive: true});
  config.assets = {...original.assets, directory: './public'};
}
// API_KEY is injected only when publishing, never while building the image.
if (config.vars && Object.hasOwn(config.vars, 'API_KEY')) throw new Error('API_KEY must not be stored in Wrangler vars');
await writeFile(path.join(output, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
await writeFile(path.join(output, 'build-info.json'), `${JSON.stringify({
  entry,
  celld: 'v0.6.3'
}, null, 2)}\n`);

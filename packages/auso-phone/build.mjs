import { build, context } from 'esbuild';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

/** IIFE for Blade/Livewire (<script src=…>), ESM for Vite/bundler consumers. */
const targets = [
  {
    entryPoints: ['src/index.js'],
    outfile: 'dist/auso-phone.js',
    format: 'iife',
    globalName: 'AusoPhoneBundle',
    minify: false,
  },
  {
    entryPoints: ['src/index.js'],
    outfile: 'dist/auso-phone.min.js',
    format: 'iife',
    globalName: 'AusoPhoneBundle',
    minify: true,
  },
  {
    entryPoints: ['src/index.js'],
    outfile: 'dist/auso-phone.esm.js',
    format: 'esm',
    minify: false,
  },
];

const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome100', 'edge100', 'firefox100', 'safari15'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
  console.log('built dist/auso-phone.js, dist/auso-phone.min.js, dist/auso-phone.esm.js');
}

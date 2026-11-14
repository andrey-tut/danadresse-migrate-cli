#!/usr/bin/env node
import { run } from '../dist/index.js';
run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}).catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
});

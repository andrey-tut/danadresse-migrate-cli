#!/usr/bin/env node
/**
 * @danadresse/migrate-cli
 *
 * Scans a project for DAWA URLs (dawa.aws.dk, api.dataforsyningen.dk, and the
 * dawa-autocomplete2 widget on cdn.dataforsyningen.dk) and either prints a diff
 * or writes replacements.
 *
 * Usage:
 *   npx @danadresse/migrate-cli                  # dry-run, show diff
 *   npx @danadresse/migrate-cli --write          # apply changes
 *   npx @danadresse/migrate-cli --target src/    # restrict scan
 *   npx @danadresse/migrate-cli --key dawa_test_...  # set X-Api-Key reminder
 *   npx @danadresse/migrate-cli --fail-on-found  # CI gate: exit 1 if DAWA is used
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import pc from 'picocolors';

const TARGET_HOST = 'api.danadresse.dk';
const TARGET_URL = `https://${TARGET_HOST}`;

// One pass per line. Group 1 = optional scheme. A DAWA host is matched with OR
// without a scheme: config values (`DAWA_HOST=dawa.aws.dk`), protocol-relative
// URLs (`//dawa.aws.dk/...`) and docs used to be missed entirely. The lookbehind
// keeps us off look-alike hosts (`notdawa.aws.dk`, `x.api.dataforsyningen.dk`).
const HOST_RE = /(https?:\/\/)?(?<![\w.-])(?:dawa\.aws\.dk|api\.dataforsyningen\.dk)(?![\w-])/g;
// DAWA's JS widget on the Dataforsyningen CDN — Danadresse serves the same paths.
const CDN_RE = /(https?:\/\/)?(?<![\w.-])cdn\.dataforsyningen\.dk(?=\/dawa\/assets\/dawa-autocomplete2\/)/g;
const SOURCE_PATTERNS = [HOST_RE, CDN_RE];
const WIDGET_RE = /dawa-autocomplete2(\.min)?\.js/;

/** Scheme-ful match → https URL; bare host → bare host (keeps the original form). */
function replacement(scheme: string | undefined): string {
    return scheme ? TARGET_URL : TARGET_HOST;
}

const DEFAULT_GLOBS = [
    '**/*.{js,ts,jsx,tsx,mjs,cjs}',
    '**/*.{py,php,rb,go,java,cs,kt,swift,rs}',
    '**/*.{html,vue,svelte,astro}',
    '**/*.{json,yaml,yml,env,toml,ini,conf,cfg}',
    '**/*.{md,rst,txt}',
    // Dotfiles: .env, .env.local, .env.production … and CI workflows.
    '**/.env',
    '**/.env.*',
    '**/.github/**/*.{yml,yaml}',
    '**/.gitlab-ci.yml',
    '!**/node_modules/**',
    '!**/.git/**',
    '!**/.cache/**',
    '!**/.yarn/**',
    '!**/.venv/**',
    '!**/venv/**',
    '!**/dist/**',
    '!**/build/**',
    '!**/__pycache__/**',
    '!**/.next/**',
    '!**/vendor/**',
];

interface CliOptions {
    write: boolean;
    target: string;
    keyHint: string | null;
    showHelp: boolean;
    failOnFound: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = { write: false, target: '.', keyHint: null, showHelp: false,
                               failOnFound: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--write': case '-w': opts.write = true; break;
            case '--target': case '-t': opts.target = argv[++i] ?? '.'; break;
            case '--key': case '--apikey': opts.keyHint = argv[++i] ?? null; break;
            // Subcommand form used in our docs: `scan <path>` (dry-run) / `rewrite <path>`.
            case 'scan':               opts.write = false; break;
            case 'rewrite':            opts.write = true; break;
            case '--help': case '-h':  opts.showHelp = true; break;
            case '--fail-on-found': case '--ci': opts.failOnFound = true; break;
            default:
                if (a.startsWith('--')) console.warn(pc.yellow(`Unknown flag: ${a}`));
                else opts.target = a;
        }
    }
    return opts;
}

function help(): void {
    console.log(`
${pc.bold('@danadresse/migrate-cli')} — Migrate codebase from DAWA → Danadresse

${pc.bold('Usage:')}
    npx @danadresse/migrate-cli [options] [path]
    npx @danadresse/migrate-cli scan <path>          # same as the default dry-run
    npx @danadresse/migrate-cli rewrite <path>       # same as --write

${pc.bold('Options:')}
    -w, --write              Apply changes (default: dry-run with diff)
    -t, --target <path>      Project root to scan (default: current dir)
        --key <api_key>      Show reminder code with this X-Api-Key
        --fail-on-found      Exit with code 1 when any DAWA reference is found
                             (alias --ci) — use it to gate CI
    -h, --help               Show this help

${pc.bold('Examples:')}
    npx @danadresse/migrate-cli                    # show what would change
    npx @danadresse/migrate-cli --write            # apply
    npx @danadresse/migrate-cli --target src/      # scan only src/
    npx @danadresse/migrate-cli --key dawa_test_xxx # show example header

${pc.dim('What it replaces:')}
    https://dawa.aws.dk           → https://api.danadresse.dk
    https://api.dataforsyningen.dk → https://api.danadresse.dk
    dawa.aws.dk / api.dataforsyningen.dk (no scheme) → api.danadresse.dk
    https://cdn.dataforsyningen.dk/dawa/assets/dawa-autocomplete2/… → https://api.danadresse.dk/dawa/assets/dawa-autocomplete2/…

${pc.dim('Scans')} source, config, docs, .env / .env.* and .github workflows
(skips .git, node_modules, build output).

${pc.dim('Remember:')} after migration, add ${pc.cyan('X-Api-Key')} header to your requests.
Get a free key at ${pc.cyan('https://danadresse.dk/dashboard/keys')}
`);
}

interface ScanHit {
    file: string;
    line: number;
    matched: string;
    context: string;
}

async function scanFiles(target: string): Promise<{ file: string; hits: ScanHit[] }[]> {
    // dot: true — .env files and .github/ workflows are exactly where base URLs
    // live; the README always promised .env. .git/node_modules stay excluded.
    const files = await fg(DEFAULT_GLOBS, {
        cwd: target, absolute: true, dot: true, unique: true,
    });

    const results: { file: string; hits: ScanHit[] }[] = [];
    for (const file of files) {
        let content: string;
        try {
            content = await fs.readFile(file, 'utf-8');
        } catch {
            continue;
        }
        const hits: ScanHit[] = [];
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const pat of SOURCE_PATTERNS) {
                for (const m of lines[i].matchAll(pat)) {
                    hits.push({
                        file: path.relative(target, file),
                        line: i + 1,
                        matched: m[0],
                        context: lines[i].trim(),
                    });
                }
            }
        }
        if (hits.length) results.push({ file, hits });
    }
    return results;
}

async function rewriteFile(file: string): Promise<number> {
    let content = await fs.readFile(file, 'utf-8');
    let count = 0;
    for (const pat of SOURCE_PATTERNS) {
        content = content.replace(pat, (_m: string, scheme?: string) => {
            count++;
            return replacement(scheme);
        });
    }
    if (count) await fs.writeFile(file, content, 'utf-8');
    return count;
}

/** Returns the process exit code: 1 with --fail-on-found when DAWA is referenced. */
export async function run(argv: string[]): Promise<number> {
    const opts = parseArgs(argv);
    if (opts.showHelp) { help(); return 0; }

    const target = path.resolve(opts.target);
    console.log(pc.bold(`\n🔍 Scanning ${pc.cyan(target)}...\n`));

    const scan = await scanFiles(target);
    const totalFiles = scan.length;
    const totalHits = scan.reduce((s, f) => s + f.hits.length, 0);

    if (!totalHits) {
        console.log(pc.green('✓ No DAWA URLs found. Your code may already be migrated, or it doesn\'t use DAWA.\n'));
        return 0;
    }

    console.log(pc.bold(`Found ${pc.yellow(String(totalHits))} occurrence(s) in ${pc.yellow(String(totalFiles))} file(s):\n`));

    for (const { file, hits } of scan) {
        console.log(pc.bold(pc.cyan(`  ${hits[0].file}`)));
        for (const h of hits) {
            console.log(`    ${pc.dim(`${h.line}:`)} ${h.context}`);
            const scheme = /^https?:\/\//.test(h.matched) ? 'x' : undefined;
            const newContext = h.context.split(h.matched).join(pc.green(replacement(scheme)));
            console.log(`    ${pc.dim('  →')} ${newContext}`);
        }
        console.log();
    }

    if (opts.write) {
        console.log(pc.bold(pc.yellow('\n✏️  Applying changes...\n')));
        let totalReplaced = 0;
        for (const { file } of scan) {
            const n = await rewriteFile(file);
            if (n) {
                totalReplaced += n;
                console.log(pc.green(`  ✓ ${path.relative(target, file)} (${n} replacement${n === 1 ? '' : 's'})`));
            }
        }
        console.log(pc.bold(pc.green(`\n✓ Done. ${totalReplaced} replacement(s) across ${scan.length} file(s).\n`)));
    } else {
        console.log(pc.dim('Run with ') + pc.bold('--write') + pc.dim(' to apply changes.'));
    }

    // Reminder про API key
    const keyHint = opts.keyHint ?? 'dawa_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const usesWidget = scan.some(f => f.hits.some(h => WIDGET_RE.test(h.context)));
    if (usesWidget) {
        console.log(`
${pc.bold(pc.cyan('⚠ DAWA autocomplete widget found'))} (dawa-autocomplete2). It is hosted on the same
path at Danadresse — append your key to the script URL, nothing else changes:

<script src="${TARGET_URL}/js/autocomplete/dawa-autocomplete2.min.js?key=${keyHint}"></script>

${pc.dim('Guide:')} ${pc.cyan('https://danadresse.dk/en/migration#autocomplete-widget')}`);
    }
    console.log(`
${pc.bold(pc.cyan('⚠ Next step:'))} add an ${pc.cyan('X-Api-Key')} header to your requests.

${pc.dim('// Example (TypeScript):')}
const r = await fetch('${TARGET_URL}/autocomplete?q=R%C3%A5d', {
    headers: { 'X-Api-Key': '${keyHint}' }
});

${pc.dim('// Example (Python):')}
import httpx
r = httpx.get('${TARGET_URL}/autocomplete', params={'q': 'Råd'},
              headers={'X-Api-Key': '${keyHint}'})

${pc.bold('Get a key:')} ${pc.cyan('https://danadresse.dk/dashboard/keys')}  ${pc.dim('·')}  ${pc.bold('Plans & free tier:')} ${pc.cyan('https://danadresse.dk/#pricing')}
`);
    if (opts.failOnFound) {
        console.log(pc.red(`✗ --fail-on-found: ${totalHits} DAWA reference(s) found.`));
        return 1;
    }
    return 0;
}

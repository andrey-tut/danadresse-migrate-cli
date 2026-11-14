import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/index';

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dda-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
});

const SRC = [
    '<script src="https://dawa.aws.dk/js/autocomplete/dawa-autocomplete2.min.js"></script>',
    '<script src="https://cdn.dataforsyningen.dk/dawa/assets/dawa-autocomplete2/1.0.2/dawa-autocomplete2.min.js"></script>',
    '<img src="https://cdn.dataforsyningen.dk/other/logo.png">',
    "fetch('https://api.dataforsyningen.dk/adresser?q=x')",
].join('\n');

describe('migrate-cli', () => {
    it('dry-run changes nothing', async () => {
        await fs.writeFile(path.join(dir, 'a.html'), SRC);
        await run([dir]);
        expect(await fs.readFile(path.join(dir, 'a.html'), 'utf-8')).toBe(SRC);
    });

    it('--write rewrites DAWA hosts and the widget CDN path, leaves other CDN files', async () => {
        await fs.writeFile(path.join(dir, 'a.html'), SRC);
        await run(['--write', dir]);
        const out = await fs.readFile(path.join(dir, 'a.html'), 'utf-8');
        expect(out).not.toContain('dawa.aws.dk');
        expect(out).not.toContain('api.dataforsyningen.dk');
        expect(out).toContain('https://api.danadresse.dk/js/autocomplete/dawa-autocomplete2.min.js');
        expect(out).toContain('https://api.danadresse.dk/dawa/assets/dawa-autocomplete2/1.0.2/');
        expect(out).toContain('https://cdn.dataforsyningen.dk/other/logo.png');
    });

    it('prints the ?key= hint when the widget is found', async () => {
        await fs.writeFile(path.join(dir, 'a.html'), SRC);
        const log = vi.spyOn(console, 'log');
        await run([dir, '--key', 'dawa_test_abc']);
        const text = log.mock.calls.map(c => String(c[0])).join('\n');
        expect(text).toContain('dawa-autocomplete2.min.js?key=dawa_test_abc');
    });

    it('scans .env* and .github workflows, still skips .git and node_modules', async () => {
        await fs.writeFile(path.join(dir, '.env'), 'DAWA_URL=https://dawa.aws.dk\n');
        await fs.writeFile(path.join(dir, '.env.production'), 'DAWA=https://api.dataforsyningen.dk\n');
        await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
        await fs.writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'),
            'run: curl https://dawa.aws.dk/postnumre\n');
        for (const skip of ['.git', 'node_modules']) {
            await fs.mkdir(path.join(dir, skip), { recursive: true });
            await fs.writeFile(path.join(dir, skip, 'x.js'), "fetch('https://dawa.aws.dk')");
        }
        await run(['--write', dir]);
        expect(await fs.readFile(path.join(dir, '.env'), 'utf-8'))
            .toBe('DAWA_URL=https://api.danadresse.dk\n');
        expect(await fs.readFile(path.join(dir, '.env.production'), 'utf-8'))
            .toContain('https://api.danadresse.dk');
        expect(await fs.readFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf-8'))
            .toContain('https://api.danadresse.dk/postnumre');
        expect(await fs.readFile(path.join(dir, '.git', 'x.js'), 'utf-8')).toContain('dawa.aws.dk');
        expect(await fs.readFile(path.join(dir, 'node_modules', 'x.js'), 'utf-8')).toContain('dawa.aws.dk');
    });

    it('detects protocol-less hosts and keeps their form; ignores look-alikes', async () => {
        const src = [
            'DAWA_HOST=dawa.aws.dk',
            "const u = '//api.dataforsyningen.dk/adresser';",
            'host: notdawa.aws.dk',
            'see http://dawa.aws.dk/dok',
        ].join('\n');
        await fs.writeFile(path.join(dir, 'c.yaml'), src);
        await run(['--write', dir]);
        expect(await fs.readFile(path.join(dir, 'c.yaml'), 'utf-8')).toBe([
            'DAWA_HOST=api.danadresse.dk',
            "const u = '//api.danadresse.dk/adresser';",
            'host: notdawa.aws.dk',
            'see https://api.danadresse.dk/dok',
        ].join('\n'));
    });

    it('--fail-on-found returns exit code 1 only when DAWA is referenced', async () => {
        await fs.writeFile(path.join(dir, 'a.js'), "fetch('https://dawa.aws.dk/x')");
        expect(await run([dir])).toBe(0);                      // plain scan never fails
        expect(await run([dir, '--fail-on-found'])).toBe(1);
        expect(await run([dir, '--ci'])).toBe(1);
        await run(['--write', dir]);
        expect(await run([dir, '--fail-on-found'])).toBe(0);  // clean after rewrite
    });

    it('does not hard-code a call allowance; links pricing', async () => {
        await fs.writeFile(path.join(dir, 'a.js'), "fetch('https://dawa.aws.dk/x')");
        const log = vi.spyOn(console, 'log');
        await run([dir]);
        const text = log.mock.calls.map(c => String(c[0])).join('\n');
        expect(text).not.toMatch(/calls\/month/);
        expect(text).toContain('https://danadresse.dk/#pricing');
        const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf-8');
        expect(readme).not.toMatch(/\d[,.]?\d{3} calls/);
    });

    it('accepts the documented subcommands: scan (dry-run) and rewrite --apikey', async () => {
        await fs.writeFile(path.join(dir, 'a.html'), SRC);
        await run(['scan', dir]);
        expect(await fs.readFile(path.join(dir, 'a.html'), 'utf-8')).toBe(SRC);
        await run(['rewrite', dir, '--apikey', 'dawa_live_x']);
        expect(await fs.readFile(path.join(dir, 'a.html'), 'utf-8')).not.toContain('dawa.aws.dk');
    });
});

#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLabelerArgs, startLabeler } from './exam-evaluation-labeler/server.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
    let running;
    try {
        const options = parseLabelerArgs(process.argv.slice(2));
        running = await startLabeler({ ...options, repositoryRoot });
    } catch {
        process.stderr.write('标注器启动失败：请检查参数、私有目录和文件权限\n');
        process.exitCode = 2;
        return;
    }
    const shutdown = async () => {
        await running.close();
        process.exitCode = 0;
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

await main();

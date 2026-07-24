const fs = require('node:fs');
const path = require('node:path');

function assertGeneratedPullTree(publicDir) {
    for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
        const entryPath = path.join(publicDir, entry.name);
        if (entry.isSymbolicLink()) {
            throw new Error(`public baseline 内の symbolic link を削除しません: ${entryPath}`);
        }
        if (entry.name === '.remote') {
            if (!entry.isDirectory()) {
                throw new Error(`public/.remote が directory ではありません: ${entryPath}`);
            }
            for (const remoteEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
                const remotePath = path.join(entryPath, remoteEntry.name);
                if (remoteEntry.isSymbolicLink()) {
                    throw new Error(
                        `public/.remote 内の symbolic link を削除しません: ${remotePath}`,
                    );
                }
                if (!remoteEntry.isFile() || !remoteEntry.name.endsWith('.md')) {
                    throw new Error(
                        `public/.remote 内に想定外の entry があります: ${remotePath}`,
                    );
                }
            }
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
            throw new Error(`public baseline 内に想定外の entry があります: ${entryPath}`);
        }
    }
}

function preparePull(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const publicDir = path.resolve(rootDir, 'public');
    if (path.dirname(publicDir) !== rootDir || path.basename(publicDir) !== 'public') {
        throw new Error(`public baseline の対象パスが不正です: ${publicDir}`);
    }

    if (fs.existsSync(publicDir)) {
        const stat = fs.lstatSync(publicDir);
        if (stat.isSymbolicLink()) {
            throw new Error(`public baseline が symbolic link のため削除しません: ${publicDir}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`public baseline が directory ではないため削除しません: ${publicDir}`);
        }
        assertGeneratedPullTree(publicDir);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
    fs.mkdirSync(publicDir, { recursive: true });
    return { rootDir, publicDir };
}

module.exports = {
    assertGeneratedPullTree,
    preparePull,
};

if (require.main === module) {
    try {
        const result = preparePull();
        console.log(`Prepared clean Qiita pull baseline: ${result.publicDir}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

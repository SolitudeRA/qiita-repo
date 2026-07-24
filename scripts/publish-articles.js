const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadPublicationContext } = require('./lib/article-registry');

function getPublishTargets(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const context = loadPublicationContext({ rootDir, requirePublicTargets: true });
    return {
        context,
        targets: context.articles.map((article) => ({
            articleId: article.articleId,
            itemId: article.mapEntry.item_id,
            basename: article.target.basename,
        })),
    };
}

function defaultRunner(rootDir, basename) {
    const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(executable, ['qiita', 'publish', '--', basename], {
        cwd: rootDir,
        env: process.env,
        stdio: 'inherit',
        shell: false,
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`qiita publish が失敗しました: ${basename} (exit ${result.status})`);
    }
}

function publishPlanned(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const runner = options.runner || defaultRunner;
    if (!options.runner && !process.env.QIITA_TOKEN) {
        throw new Error('QIITA_TOKEN がないため、実際の Qiita publish は実行しません');
    }

    // 全 target を先に検証してから、ID で特定した basename だけを順次公開する。
    const plan = getPublishTargets({ rootDir });
    for (const target of plan.targets) {
        console.log(
            `Publishing bound article: ${target.articleId} -> ${target.itemId} `
            + `(${target.basename})`,
        );
        runner(rootDir, target.basename, target);
    }
    return plan;
}

module.exports = {
    defaultRunner,
    getPublishTargets,
    publishPlanned,
};

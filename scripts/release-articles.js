const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { buildArticles } = require('./build-articles');
const { loadPublicationContext } = require('./lib/article-registry');
const { defaultRunner } = require('./publish-articles');

function normalizePublishBody(body) {
    if (typeof body !== 'string') {
        throw new Error('公開投影の body は文字列である必要があります');
    }

    const lines = body.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && /^[\t ]*$/.test(lines[0])) {
        lines.shift();
    }
    while (lines.length > 0 && /^[\t ]*$/.test(lines[lines.length - 1])) {
        lines.pop();
    }
    return lines.join('\n');
}

function createPublishProjection(article) {
    if (!article.target) {
        throw new Error(`公開対象がありません: ${article.articleId}`);
    }

    const { data, content } = article.target;
    const label = `${article.articleId} -> ${article.mapEntry.item_id}`;
    if (typeof data.title !== 'string' || data.title.trim() === '') {
        throw new Error(`公開投影の title が不正です: ${label}`);
    }
    if (!Array.isArray(data.tags)
        || data.tags.length === 0
        || data.tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
        throw new Error(`公開投影の tags が不正です: ${label}`);
    }
    if (typeof data.private !== 'boolean') {
        throw new Error(`公開投影の private が不正です: ${label}`);
    }
    if (data.organization_url_name !== null
        && typeof data.organization_url_name !== 'string') {
        throw new Error(`公開投影の organization_url_name が不正です: ${label}`);
    }
    if (typeof data.slide !== 'boolean') {
        throw new Error(`公開投影の slide が不正です: ${label}`);
    }

    return {
        title: data.title,
        // qiita-cli 1.6.1 も remote/local 比較時に tag 順序を無視する。
        // 表示名そのものは保持し、比較用の複製だけを UTF-16 順に並べる。
        tags: [...data.tags].sort(),
        private: data.private,
        organization_url_name: data.organization_url_name,
        slide: data.slide,
        body: normalizePublishBody(content),
    };
}

function targetIdentity(article) {
    return {
        articleId: article.articleId,
        itemId: article.mapEntry.item_id,
        basename: article.target.basename,
    };
}

function identityKey(identity) {
    return JSON.stringify([
        identity.articleId,
        identity.itemId,
        identity.basename,
    ]);
}

function snapshotBoundTargets(context) {
    const snapshots = [];
    const seen = new Set();
    for (const article of context.articles) {
        const identity = targetIdentity(article);
        const key = identityKey(identity);
        if (seen.has(key)) {
            throw new Error(
                `公開対象の同一性が重複しています: ${identity.articleId} `
                + `-> ${identity.itemId} (${identity.basename})`,
            );
        }
        seen.add(key);
        snapshots.push({
            ...identity,
            key,
            projection: createPublishProjection(article),
        });
    }
    return snapshots;
}

function assertSameBoundTargetSet(before, after) {
    const beforeKeys = new Set(before.map((snapshot) => snapshot.key));
    const afterKeys = new Set(after.map((snapshot) => snapshot.key));
    const missing = [...beforeKeys].filter((key) => !afterKeys.has(key));
    const added = [...afterKeys].filter((key) => !beforeKeys.has(key));
    if (beforeKeys.size !== afterKeys.size || missing.length > 0 || added.length > 0) {
        throw new Error(
            'build 前後で articleId/itemId/basename の集合が変化しました: '
            + `missing=${JSON.stringify(missing)}, added=${JSON.stringify(added)}`,
        );
    }
}

function releaseBoundArticles(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const runner = options.runner || defaultRunner;
    const builder = options.builder || buildArticles;
    if (!options.runner && !process.env.QIITA_TOKEN) {
        throw new Error('QIITA_TOKEN がないため、実際の Qiita publish は実行しません');
    }

    // pull 済みの全 target を、build によるファイル書き込みより前に snapshot する。
    const beforeContext = loadPublicationContext({
        rootDir,
        requirePublicTargets: true,
    });
    const before = snapshotBoundTargets(beforeContext);

    // build は同じ Node.js process 内で完了させ、その後に全件を再読込・再検証する。
    const buildResult = builder({ rootDir });
    if (!buildResult
        || buildResult.parsed !== before.length
        || buildResult.linked !== before.length) {
        throw new Error(
            'build が全 binding を処理しませんでした: '
            + `expected=${before.length}, parsed=${buildResult?.parsed ?? 'missing'}, `
            + `linked=${buildResult?.linked ?? 'missing'}`,
        );
    }
    const afterContext = loadPublicationContext({
        rootDir,
        requirePublicTargets: true,
    });
    const after = snapshotBoundTargets(afterContext);
    assertSameBoundTargetSet(before, after);

    const beforeByKey = new Map(
        before.map((snapshot) => [snapshot.key, snapshot]),
    );
    const targets = after
        .filter((snapshot) => (
            !isDeepStrictEqual(
                beforeByKey.get(snapshot.key).projection,
                snapshot.projection,
            )
        ))
        .map((snapshot) => ({
            articleId: snapshot.articleId,
            itemId: snapshot.itemId,
            basename: snapshot.basename,
        }));

    // ここまで runner は一度も呼ばない。全件の再検証・同一性照合・diff
    // 計画が成功した後だけ、変更された明示的 binding を公開する。
    for (const target of targets) {
        console.log(
            `Publishing changed bound article: ${target.articleId} `
            + `-> ${target.itemId} (${target.basename})`,
        );
        runner(rootDir, target.basename, target);
    }

    return {
        context: afterContext,
        targets,
        changed: targets.length,
        unchanged: after.length - targets.length,
    };
}

module.exports = {
    assertSameBoundTargetSet,
    createPublishProjection,
    normalizePublishBody,
    releaseBoundArticles,
    snapshotBoundTargets,
};

if (require.main === module) {
    try {
        const result = releaseBoundArticles();
        console.log(
            `Released ${result.changed} changed bound articles; `
            + `${result.unchanged} unchanged articles were skipped.`,
        );
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

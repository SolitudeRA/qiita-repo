const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const {
    injectArticleMarker,
    loadPublicationContext,
} = require('./lib/article-registry');

const ASCII_TAG_IDENTITY_SEPARATORS = /[._\-\u0009-\u000d\u0020]/g;

function sourceOrRemote(sourceData, remoteData, fieldName, fallback) {
    if (Object.hasOwn(sourceData, fieldName)) {
        return sourceData[fieldName];
    }
    if (Object.hasOwn(remoteData, fieldName)) {
        return remoteData[fieldName];
    }
    return fallback;
}

function normalizeTagIdentity(tag) {
    if (typeof tag !== 'string') {
        return null;
    }
    const identity = tag
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(ASCII_TAG_IDENTITY_SEPARATORS, '');
    return identity === '' ? null : identity;
}

function indexUniqueTags(tags) {
    if (!Array.isArray(tags)) {
        return null;
    }
    const byIdentity = new Map();
    for (const tag of tags) {
        const identity = normalizeTagIdentity(tag);
        if (identity === null || byIdentity.has(identity)) {
            return null;
        }
        byIdentity.set(identity, tag);
    }
    return byIdentity;
}

function selectBoundTargetTags(sourceTags, remoteTags) {
    const fallback = Array.isArray(sourceTags) ? [...sourceTags] : sourceTags;
    const sourceByIdentity = indexUniqueTags(sourceTags);
    const remoteByIdentity = indexUniqueTags(remoteTags);
    // 既存 binding の表示差分だけを保護する。集合差分や衝突は実編集として
    // source を優先し、曖昧な対応を推測しない。
    if (
        sourceByIdentity === null
        || remoteByIdentity === null
        || sourceByIdentity.size !== remoteByIdentity.size
        || [...sourceByIdentity.keys()].some(
            (identity) => !remoteByIdentity.has(identity),
        )
    ) {
        return fallback;
    }
    return sourceTags.map(
        (tag) => remoteByIdentity.get(normalizeTagIdentity(tag)),
    );
}

function planPublicArticles(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));

    // loadPublicationContext は manifest / map / source / public の全件を検証する。
    // この呼び出しが成功するまで、生成先へは一切書き込まない。
    const context = loadPublicationContext({ rootDir, requirePublicTargets: true });
    const writes = context.articles.map((article) => {
        const remoteData = article.target.data;
        const sourceData = article.sourceData;
        const metadata = {
            title: sourceData.title,
            tags: selectBoundTargetTags(sourceData.tags, remoteData.tags),
            // manifest の active + targets.qiita.desired=published は公開記事を意味する。
            // pull 済み target が private:true でも引き継がない。
            private: false,
            updated_at: remoteData.updated_at,
            id: article.mapEntry.item_id,
            organization_url_name: sourceOrRemote(
                sourceData,
                remoteData,
                'organization_url_name',
                null,
            ),
            slide: sourceOrRemote(sourceData, remoteData, 'slide', false),
            ignorePublish: false,
        };
        const body = injectArticleMarker(article.sourceBody, article.articleId);

        return {
            articleId: article.articleId,
            itemId: article.mapEntry.item_id,
            source: article.source,
            targetFile: article.target.file,
            targetPath: article.target.filePath,
            content: matter.stringify(body, metadata),
        };
    });

    return { context, writes };
}

function writePublicArticles(options = {}) {
    const plan = planPublicArticles(options);
    for (const write of plan.writes) {
        fs.writeFileSync(write.targetPath, write.content, 'utf8');
        console.log(
            `Prepared: ${write.articleId} -> ${write.itemId} (${write.targetFile})`,
        );
    }
    return plan;
}

module.exports = {
    planPublicArticles,
    selectBoundTargetTags,
    writePublicArticles,
};

if (require.main === module) {
    try {
        const plan = writePublicArticles();
        console.log(`ID-first 形式で ${plan.writes.length} 記事を準備しました。`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

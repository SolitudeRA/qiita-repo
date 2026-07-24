import type {
    ArticleRegistryExports,
    PublicationContextWithTargets,
    RootDirOptions,
    UnknownRecord,
} from './lib/article-registry.ts';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const matter: typeof import('gray-matter') = require('gray-matter');
const {
    injectArticleMarker,
    loadPublicationContext,
} = require('./lib/article-registry.ts') as ArticleRegistryExports;

const ASCII_TAG_IDENTITY_SEPARATORS = /[._\-\u0009-\u000d\u0020]/g;

function sourceOrRemote<T>(
    sourceData: UnknownRecord,
    remoteData: UnknownRecord,
    fieldName: string,
    fallback: T,
): unknown {
    if (Object.hasOwn(sourceData, fieldName)) {
        return sourceData[fieldName];
    }
    if (Object.hasOwn(remoteData, fieldName)) {
        return remoteData[fieldName];
    }
    return fallback;
}

function normalizeTagIdentity(tag: unknown): string | null {
    if (typeof tag !== 'string') {
        return null;
    }
    const identity = tag
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(ASCII_TAG_IDENTITY_SEPARATORS, '');
    return identity === '' ? null : identity;
}

function indexUniqueTags(tags: unknown): Map<string, string> | null {
    if (!Array.isArray(tags)) {
        return null;
    }
    const byIdentity = new Map<string, string>();
    for (const tag of tags) {
        if (typeof tag !== 'string') {
            return null;
        }
        const identity = normalizeTagIdentity(tag);
        if (identity === null || byIdentity.has(identity)) {
            return null;
        }
        byIdentity.set(identity, tag);
    }
    return byIdentity;
}

function selectBoundTargetTags(sourceTags: unknown, remoteTags: unknown): unknown {
    const fallback = Array.isArray(sourceTags) ? [...sourceTags] : sourceTags;
    if (!Array.isArray(sourceTags)) {
        return fallback;
    }
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
    return sourceTags.map((tag) => {
        const identity = normalizeTagIdentity(tag);
        return identity === null ? tag : (remoteByIdentity.get(identity) ?? tag);
    });
}

interface PublicArticleWrite {
    articleId: string;
    itemId: string;
    source: string;
    targetFile: string;
    targetPath: string;
    content: string;
}

export interface PublicArticlePlan {
    context: PublicationContextWithTargets;
    writes: PublicArticleWrite[];
}

function planPublicArticles(options: RootDirOptions = {}): PublicArticlePlan {
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

function writePublicArticles(options: RootDirOptions = {}): PublicArticlePlan {
    const plan = planPublicArticles(options);
    for (const write of plan.writes) {
        fs.writeFileSync(write.targetPath, write.content, 'utf8');
        console.log(
            `Prepared: ${write.articleId} -> ${write.itemId} (${write.targetFile})`,
        );
    }
    return plan;
}

export interface ParseArticlesExports {
    planPublicArticles: typeof planPublicArticles;
    selectBoundTargetTags: typeof selectBoundTargetTags;
    writePublicArticles: typeof writePublicArticles;
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
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

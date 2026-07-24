const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const {
    INLINE_REFERENCE_PATTERN,
    SERIES_END,
    SERIES_START,
    RegistryValidationError,
    articleMarker,
    loadPublicationContext,
} = require('./lib/article-registry.ts');

function replaceInlineArticleLinks(content, context) {
    return content.replace(INLINE_REFERENCE_PATTERN, (_match, rawTarget) => {
        const articleId = /^article:([0-9a-f]{32})$/.exec(rawTarget.trim())[1];
        const target = context.articlesById.get(articleId);
        return `[${target.sourceData.title}]`
            + `(https://qiita.com/${context.qiitaUser}/items/${target.mapEntry.item_id})`;
    });
}

function countOccurrences(content, needle) {
    return content.split(needle).length - 1;
}

function removeSeriesBlock(content) {
    const startIndex = content.indexOf(SERIES_START);
    if (startIndex === -1) {
        return content;
    }
    const endIndex = content.indexOf(SERIES_END, startIndex);
    return `${content.slice(0, startIndex)}${content.slice(endIndex + SERIES_END.length)}`
        .replace(/\n{3,}/g, '\n\n');
}

function insertSeriesBlock(content, article, seriesArticles, context) {
    const links = seriesArticles
        .filter((candidate) => candidate.articleId !== article.articleId)
        .map((candidate) => (
            `[${candidate.sourceData.title}]`
            + `(https://qiita.com/${context.qiitaUser}/items/${candidate.mapEntry.item_id})`
        ));
    const block = [
        SERIES_START,
        '',
        `${article.sourceData.series} シリーズ記事：`,
        '',
        ...links,
        '',
        SERIES_END,
    ].join('\n');

    const withoutOldBlock = removeSeriesBlock(content);
    const marker = articleMarker(article.articleId);
    const markerIndex = withoutOldBlock.indexOf(marker);
    const afterMarkerIndex = markerIndex + marker.length;
    const before = withoutOldBlock.slice(0, afterMarkerIndex);
    const after = withoutOldBlock
        .slice(afterMarkerIndex)
        .replace(/^(?:\r?\n)+/, '');
    return `${before}\n\n${block}\n\n${after}`;
}

function planSeriesLinks(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const context = loadPublicationContext({ rootDir, requirePublicTargets: true });
    const errors = [];
    const seriesGroups = new Map();

    for (const article of context.articles) {
        if (typeof article.sourceData.series !== 'string') {
            continue;
        }
        if (!seriesGroups.has(article.sourceData.series)) {
            seriesGroups.set(article.sourceData.series, []);
        }
        seriesGroups.get(article.sourceData.series).push(article);
    }
    for (const group of seriesGroups.values()) {
        // 既存実装と同じく source ファイル名順。ただし同一性には使用しない。
        group.sort((left, right) => left.sourceBasename.localeCompare(right.sourceBasename));
    }

    const writes = [];
    for (const article of context.articles) {
        const content = article.target.content;
        const marker = articleMarker(article.articleId);
        if (!content.includes(marker)) {
            errors.push(
                `public/${article.target.file}: parser が生成する article-id marker がありません`,
            );
            continue;
        }

        const series = article.sourceData.series;
        let updatedBody = content;
        if (typeof series === 'string') {
            const startCount = countOccurrences(content, SERIES_START);
            const endCount = countOccurrences(content, SERIES_END);
            if (startCount !== endCount || startCount > 1) {
                errors.push(
                    `public/${article.target.file}: series marker が不正です `
                    + `(START=${startCount}, END=${endCount})`,
                );
                continue;
            }
            if (startCount === 1
                && content.indexOf(SERIES_END) < content.indexOf(SERIES_START)) {
                errors.push(`public/${article.target.file}: series marker の順序が不正です`);
                continue;
            }
            updatedBody = insertSeriesBlock(
                updatedBody,
                article,
                seriesGroups.get(series),
                context,
            );
        }

        updatedBody = replaceInlineArticleLinks(updatedBody, context)
            .replace(/\n{3,}/g, '\n\n');
        writes.push({
            articleId: article.articleId,
            targetFile: article.target.file,
            targetPath: article.target.filePath,
            content: matter.stringify(updatedBody, article.target.data),
        });
    }

    if (errors.length > 0) {
        throw new RegistryValidationError(errors);
    }
    return { context, writes };
}

function writeSeriesLinks(options = {}) {
    const plan = planSeriesLinks(options);
    for (const write of plan.writes) {
        fs.writeFileSync(write.targetPath, write.content, 'utf8');
        console.log(`Generated links: ${write.articleId} (${write.targetFile})`);
    }
    return plan;
}

module.exports = {
    planSeriesLinks,
    replaceInlineArticleLinks,
    writeSeriesLinks,
};

if (require.main === module) {
    try {
        const plan = writeSeriesLinks();
        console.log(`ID-first リンクを ${plan.writes.length} 記事へ生成しました。`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

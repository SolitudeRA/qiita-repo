const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');

const ARTICLE_ID_PATTERN = /^[0-9a-f]{32}$/;
const QIITA_ITEM_ID_PATTERN = /^[0-9a-f]{20}$/;
const INLINE_REFERENCE_PATTERN = /<<<([^>\r\n]+)>>>/g;
const SERIES_START = '<!-- START_SERIES -->';
const SERIES_END = '<!-- END_SERIES -->';

class RegistryValidationError extends Error {
    constructor(errors) {
        super(`記事レジストリの検証に失敗しました:\n${errors.map((error) => `- ${error}`).join('\n')}`);
        this.name = 'RegistryValidationError';
        this.errors = errors;
    }
}

function readJsonFile(filePath, label, errors) {
    if (!fs.existsSync(filePath)) {
        errors.push(`${label} が見つかりません: ${filePath}`);
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        errors.push(`${label} を JSON として読み込めません: ${error.message}`);
        return null;
    }
}

function normalizeRelativePath(value) {
    return value.split(path.sep).join('/');
}

function isPathInside(parentDir, candidatePath) {
    const relativePath = path.relative(parentDir, candidatePath);
    return relativePath !== ''
        && !relativePath.startsWith(`..${path.sep}`)
        && relativePath !== '..'
        && !path.isAbsolute(relativePath);
}

function listMarkdownFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const result = [];
    const visit = (currentDirectory) => {
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                result.push(normalizeRelativePath(path.relative(directoryPath, entryPath)));
            }
        }
    };

    visit(directoryPath);
    return result.sort((left, right) => left.localeCompare(right));
}

function getArticleMarkers(content) {
    const markerPattern = /<!--\s*blog-project:article-id=([^>]*?)\s*-->/g;
    return [...content.matchAll(markerPattern)].map((match) => ({
        raw: match[0],
        articleId: match[1].trim(),
    }));
}

function articleMarker(articleId) {
    return `<!-- blog-project:article-id=${articleId} -->`;
}

function injectArticleMarker(content, articleId) {
    const markerPattern = /<!--\s*blog-project:article-id=[^>]*?\s*-->/g;
    const withoutMarkers = content
        .replace(markerPattern, '')
        .replace(/^(?:\r?\n)+/, '');
    return `${articleMarker(articleId)}\n\n${withoutMarkers}`;
}

function getInlineReferences(content) {
    const references = [];
    for (const match of content.matchAll(INLINE_REFERENCE_PATTERN)) {
        const rawTarget = match[1].trim();
        const idMatch = /^article:([0-9a-f]{32})$/.exec(rawTarget);
        references.push({
            raw: match[0],
            rawTarget,
            articleId: idMatch ? idMatch[1] : null,
        });
    }
    return references;
}

function parseMarkdownFile(filePath, label, errors) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        errors.push(`${label} を読み込めません: ${error.message}`);
        return null;
    }

    if (raw.length === 0) {
        errors.push(`${label} は空ファイルです`);
        return null;
    }
    if (raw.includes('\0')) {
        errors.push(`${label} に NUL バイトが含まれています`);
        return null;
    }

    try {
        const parsed = matter(raw);
        return {
            raw,
            data: parsed.data,
            content: parsed.content,
        };
    } catch (error) {
        errors.push(`${label} の front matter を解析できません: ${error.message}`);
        return null;
    }
}

function validateSourceArticle(article, publishableIds, errors) {
    const { articleId, source, sourceData, sourceBody } = article;
    const label = `source(${articleId}, ${source})`;

    if (typeof sourceData.title !== 'string' || sourceData.title.trim() === '') {
        errors.push(`${label}: title は空でない文字列である必要があります`);
    }
    if (!Array.isArray(sourceData.tags)
        || sourceData.tags.length === 0
        || sourceData.tags.length > 5
        || sourceData.tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
        errors.push(`${label}: tags は 1〜5 個の空でない文字列である必要があります`);
    }
    if (sourceBody.trim() === '') {
        errors.push(`${label}: 本文は空にできません`);
    }
    if (typeof sourceData.local_updated_at !== 'string'
        || Number.isNaN(Date.parse(sourceData.local_updated_at))) {
        errors.push(`${label}: local_updated_at は有効な ISO 8601 日時である必要があります`);
    }
    if (typeof sourceData.article_id !== 'string'
        || !ARTICLE_ID_PATTERN.test(sourceData.article_id)) {
        errors.push(`${label}: front matter article_id は小文字 32hex で必須です`);
    } else if (sourceData.article_id !== articleId) {
        errors.push(`${label}: front matter article_id が manifest と一致しません`);
    }
    if (Object.hasOwn(sourceData, 'private') && typeof sourceData.private !== 'boolean') {
        errors.push(`${label}: private は boolean である必要があります`);
    }
    if (Object.hasOwn(sourceData, 'slide') && typeof sourceData.slide !== 'boolean') {
        errors.push(`${label}: slide は boolean である必要があります`);
    }
    if (Object.hasOwn(sourceData, 'organization_url_name')
        && sourceData.organization_url_name !== null
        && typeof sourceData.organization_url_name !== 'string') {
        errors.push(`${label}: organization_url_name は null または文字列である必要があります`);
    }

    if (sourceData.series !== undefined
        && sourceData.series !== null
        && (typeof sourceData.series !== 'string' || sourceData.series.trim() === '')) {
        errors.push(`${label}: series は null または空でない文字列である必要があります`);
    }
    if (typeof sourceData.series === 'string') {
        const startCount = sourceBody.split(SERIES_START).length - 1;
        const endCount = sourceBody.split(SERIES_END).length - 1;
        if (startCount !== endCount || startCount > 1) {
            errors.push(
                `${label}: series marker が不正です `
                + `(START=${startCount}, END=${endCount})`,
            );
        } else if (startCount === 1
            && sourceBody.indexOf(SERIES_END) < sourceBody.indexOf(SERIES_START)) {
            errors.push(`${label}: series marker の順序が不正です`);
        }
    }

    const markers = getArticleMarkers(sourceBody);
    if (markers.length > 1) {
        errors.push(`${label}: article-id marker が複数あります`);
    }
    for (const marker of markers) {
        if (!ARTICLE_ID_PATTERN.test(marker.articleId)) {
            errors.push(`${label}: 不正な article-id marker です: ${marker.articleId}`);
        } else if (marker.articleId !== articleId) {
            errors.push(`${label}: article-id marker が manifest と一致しません`);
        }
    }

    const references = getInlineReferences(sourceBody);
    for (const reference of references) {
        if (!reference.articleId) {
            errors.push(
                `${label}: タイトル参照 ${reference.raw} は禁止されています。`
                + ' <<<article:32hex-id>>> を使用してください',
            );
        } else if (!publishableIds.has(reference.articleId)) {
            errors.push(
                `${label}: Qiita published target ではない article_id への参照です: `
                + reference.articleId,
            );
        }
    }

    const withoutReferences = sourceBody.replace(INLINE_REFERENCE_PATTERN, '');
    if (withoutReferences.includes('<<<') || withoutReferences.includes('>>>')) {
        errors.push(`${label}: 閉じていない、または不正なインライン記事参照があります`);
    }
}

function loadPublicationContext(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..'));
    const requirePublicTargets = options.requirePublicTargets !== false;
    const prePublishDir = path.join(rootDir, 'pre-publish');
    const publicDir = path.join(rootDir, 'public');
    const manifestPath = path.join(prePublishDir, 'manifest.json');
    const articleMapPath = path.join(rootDir, 'article-map.json');
    const errors = [];

    const manifest = readJsonFile(manifestPath, 'pre-publish/manifest.json', errors);
    const articleMap = readJsonFile(articleMapPath, 'article-map.json', errors);
    if (!manifest || !articleMap) {
        throw new RegistryValidationError(errors);
    }

    if (manifest.schema_version !== 1) {
        errors.push('manifest.schema_version は 1 である必要があります');
    }
    if (!Array.isArray(manifest.articles) || manifest.articles.length === 0) {
        errors.push('manifest.articles は空でない配列である必要があります');
    }
    if (articleMap.schema_version !== 1) {
        errors.push('article-map.schema_version は 1 である必要があります');
    }
    if (articleMap.platform !== 'qiita') {
        errors.push('article-map.platform は "qiita" である必要があります');
    }
    if (typeof articleMap.qiita_user !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(articleMap.qiita_user)) {
        errors.push('article-map.qiita_user が不正です');
    }
    if (!articleMap.bindings
        || typeof articleMap.bindings !== 'object'
        || Array.isArray(articleMap.bindings)) {
        errors.push('article-map.bindings はオブジェクトである必要があります');
    }
    if (errors.length > 0) {
        throw new RegistryValidationError(errors);
    }

    const manifestIds = new Set();
    const publishableIds = new Set();
    const manifestSources = new Map();
    const ignoredSourceBasenames = new Set();
    const manifestEntries = [];
    const validArticleStates = new Set(['active', 'retiring', 'retired']);
    const validDesiredStates = new Set(['published', 'withdrawn']);

    manifest.articles.forEach((entry, index) => {
        const entryLabel = `manifest.articles[${index}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${entryLabel} はオブジェクトである必要があります`);
            return;
        }

        const articleId = entry.article_id;
        if (typeof articleId !== 'string' || !ARTICLE_ID_PATTERN.test(articleId)) {
            errors.push(`${entryLabel}.article_id は小文字 32hex である必要があります`);
        } else if (manifestIds.has(articleId)) {
            errors.push(`manifest で article_id が重複しています: ${articleId}`);
        } else {
            manifestIds.add(articleId);
        }

        if (!validArticleStates.has(entry.article_state)) {
            errors.push(
                `${entryLabel}.article_state は active|retiring|retired のいずれかが必要です`,
            );
        }

        const qiitaTarget = entry.targets?.qiita;
        if (qiitaTarget === undefined) {
            if (typeof entry.source === 'string') {
                const ignoredBasename = path.posix.basename(entry.source);
                if (ignoredBasename.endsWith('.md')) {
                    ignoredSourceBasenames.add(ignoredBasename.toLowerCase());
                }
            }
            return;
        }
        if (!qiitaTarget || typeof qiitaTarget !== 'object' || Array.isArray(qiitaTarget)) {
            errors.push(`${entryLabel}.targets.qiita はオブジェクトである必要があります`);
            return;
        }
        if (!validDesiredStates.has(qiitaTarget.desired)) {
            errors.push(
                `${entryLabel}.targets.qiita.desired は published|withdrawn のいずれかが必要です`,
            );
            return;
        }
        if (entry.article_state !== 'active' || qiitaTarget.desired !== 'published') {
            errors.push(
                `${entryLabel}: article_state=${entry.article_state}, `
                + `targets.qiita.desired=${qiitaTarget.desired} はこの切片では未対応です`,
            );
            return;
        }
        if (ARTICLE_ID_PATTERN.test(articleId || '')) {
            publishableIds.add(articleId);
        }

        const sourceMatch = typeof entry.source === 'string'
            ? /^articles\/(share|qiita)\/([^/]+\.md)$/u.exec(entry.source)
            : null;
        if (!sourceMatch) {
            errors.push(
                `${entryLabel}.source は articles/share/<basename>.md または `
                + 'articles/qiita/<basename>.md である必要があります',
            );
            return;
        }

        const sourceBasename = sourceMatch[2];
        const sourcePath = path.resolve(prePublishDir, sourceBasename);
        if (!isPathInside(prePublishDir, sourcePath)) {
            errors.push(`${entryLabel}.source の basename が pre-publish の外を指しています`);
            return;
        }

        const sourceKey = sourceBasename.toLowerCase();
        if (manifestSources.has(sourceKey)) {
            errors.push(
                `Qiita target の source basename が重複しています: ${sourceBasename} `
                + `(${manifestSources.get(sourceKey)})`,
            );
        } else {
            manifestSources.set(sourceKey, articleId || entryLabel);
        }

        manifestEntries.push({
            articleId,
            source: normalizeRelativePath(entry.source),
            sourceBasename,
            sourcePath,
            articleState: entry.article_state,
            desired: qiitaTarget.desired,
        });
    });

    const actualSources = listMarkdownFiles(prePublishDir);
    for (const actualSource of actualSources) {
        const actualSourceKey = actualSource.toLowerCase();
        if (!manifestSources.has(actualSourceKey)
            && !ignoredSourceBasenames.has(actualSourceKey)) {
            errors.push(`Qiita target として manifest に未登録の source があります: ${actualSource}`);
        }
    }
    for (const source of manifestSources.keys()) {
        if (!actualSources.some((actualSource) => actualSource.toLowerCase() === source)) {
            errors.push(`manifest の active/published Qiita source が見つかりません: ${source}`);
        }
    }

    const mapEntries = articleMap.bindings;
    const mapIds = new Set(Object.keys(mapEntries));
    const qiitaIds = new Map();
    for (const [articleId, mapEntry] of Object.entries(mapEntries)) {
        if (!ARTICLE_ID_PATTERN.test(articleId)) {
            errors.push(`article-map のキーは小文字 32hex である必要があります: ${articleId}`);
        }
        if (!publishableIds.has(articleId)) {
            errors.push(
                `article-map に active/published Qiita target ではない article_id があります: `
                + articleId,
            );
        }
        if (!mapEntry || typeof mapEntry !== 'object' || Array.isArray(mapEntry)) {
            errors.push(`article-map.${articleId} はオブジェクトである必要があります`);
            continue;
        }
        if (mapEntry.binding_state !== 'bound') {
            errors.push(
                `article-map.${articleId}.binding_state は通常公開フローでは "bound" が必要です`,
            );
        }
        if (typeof mapEntry.item_id !== 'string'
            || !QIITA_ITEM_ID_PATTERN.test(mapEntry.item_id)) {
            errors.push(`article-map.bindings.${articleId}.item_id は小文字 20hex が必要です`);
        } else if (qiitaIds.has(mapEntry.item_id)) {
            errors.push(
                `Qiita item id が重複しています: ${mapEntry.item_id} `
                + `(${qiitaIds.get(mapEntry.item_id)}, ${articleId})`,
            );
        } else {
            qiitaIds.set(mapEntry.item_id, articleId);
        }
    }
    for (const articleId of publishableIds) {
        if (!mapIds.has(articleId)) {
            errors.push(`manifest の article_id に対応する map entry がありません: ${articleId}`);
        }
    }

    const articles = [];
    for (const entry of manifestEntries) {
        if (!ARTICLE_ID_PATTERN.test(entry.articleId) || !fs.existsSync(entry.sourcePath)) {
            continue;
        }
        const sourceParsed = parseMarkdownFile(
            entry.sourcePath,
            `source(${entry.articleId}, ${entry.source})`,
            errors,
        );
        if (!sourceParsed) {
            continue;
        }
        const article = {
            ...entry,
            sourceData: sourceParsed.data,
            sourceBody: sourceParsed.content,
            mapEntry: mapEntries[entry.articleId],
        };
        articles.push(article);
    }

    for (const article of articles) {
        validateSourceArticle(article, publishableIds, errors);
    }

    const publicFiles = [];
    const publicByQiitaId = new Map();
    const publicByMarker = new Map();
    if (requirePublicTargets) {
        if (!fs.existsSync(publicDir) || !fs.statSync(publicDir).isDirectory()) {
            errors.push(`Qiita pull 後の public ディレクトリが見つかりません: ${publicDir}`);
        } else {
            for (const file of fs.readdirSync(publicDir, { withFileTypes: true })) {
                if (!file.isFile() || !file.name.endsWith('.md')) {
                    continue;
                }
                const filePath = path.join(publicDir, file.name);
                const parsed = parseMarkdownFile(filePath, `public/${file.name}`, errors);
                if (!parsed) {
                    continue;
                }
                const publicArticle = {
                    file: file.name,
                    basename: path.basename(file.name, '.md'),
                    filePath,
                    data: parsed.data,
                    content: parsed.content,
                };
                publicFiles.push(publicArticle);

                if (typeof parsed.data.id === 'string' && QIITA_ITEM_ID_PATTERN.test(parsed.data.id)) {
                    if (!publicByQiitaId.has(parsed.data.id)) {
                        publicByQiitaId.set(parsed.data.id, []);
                    }
                    publicByQiitaId.get(parsed.data.id).push(publicArticle);
                }

                const markers = getArticleMarkers(parsed.content);
                if (markers.length > 1) {
                    errors.push(`public/${file.name}: article-id marker が複数あります`);
                }
                for (const marker of markers) {
                    if (!ARTICLE_ID_PATTERN.test(marker.articleId)) {
                        errors.push(
                            `public/${file.name}: 不正な article-id marker です: ${marker.articleId}`,
                        );
                        continue;
                    }
                    if (!publishableIds.has(marker.articleId)) {
                        errors.push(
                            `public/${file.name}: active/published Qiita target ではない marker です: `
                            + marker.articleId,
                        );
                    }
                    if (publicByMarker.has(marker.articleId)) {
                        errors.push(
                            `public で article-id marker が重複しています: ${marker.articleId} `
                            + `(${publicByMarker.get(marker.articleId).file}, ${file.name})`,
                        );
                    } else {
                        publicByMarker.set(marker.articleId, publicArticle);
                    }
                }
            }
        }
    }

    if (requirePublicTargets) {
        for (const article of articles) {
            const qiitaItemId = article.mapEntry?.item_id;
            if (!QIITA_ITEM_ID_PATTERN.test(qiitaItemId || '')) {
                continue;
            }
            const targets = publicByQiitaId.get(qiitaItemId) || [];
            if (targets.length === 0) {
                errors.push(
                    `Qiita target が public にありません: ${article.articleId} -> ${qiitaItemId}`,
                );
                continue;
            }
            if (targets.length > 1) {
                errors.push(
                    `同じ Qiita item id の public target が複数あります: ${qiitaItemId}`,
                );
                continue;
            }

            const target = targets[0];
            if (target.basename.trim() === '') {
                errors.push(`public/${target.file}: publish basename が空です`);
            }
            const markers = getArticleMarkers(target.content);
            if (markers.length === 1 && markers[0].articleId !== article.articleId) {
                errors.push(
                    `map と public marker が不一致です: ${article.articleId} -> `
                    + `${qiitaItemId}, marker=${markers[0].articleId}`,
                );
            }
            const markedFile = publicByMarker.get(article.articleId);
            if (markedFile && markedFile.data.id !== qiitaItemId) {
                errors.push(
                    `article-id marker が map と異なる Qiita target にあります: `
                    + `${article.articleId} (${markedFile.data.id || 'id:null'})`,
                );
            }
            if (typeof target.data.updated_at !== 'string'
                || Number.isNaN(Date.parse(target.data.updated_at))) {
                errors.push(`public/${target.file}: updated_at が不正です`);
            }
            if (target.data.organization_url_name !== null
                && typeof target.data.organization_url_name !== 'string') {
                errors.push(
                    `public/${target.file}: organization_url_name は null または文字列が必要です`,
                );
            }
            if (typeof target.data.slide !== 'boolean') {
                errors.push(`public/${target.file}: slide は boolean が必要です`);
            }
            article.target = target;
        }
    }

    if (errors.length > 0) {
        throw new RegistryValidationError(errors);
    }

    const articlesById = new Map(articles.map((article) => [article.articleId, article]));
    return {
        rootDir,
        prePublishDir,
        publicDir,
        manifestPath,
        articleMapPath,
        manifest,
        articleMap,
        qiitaUser: articleMap.qiita_user,
        articles,
        articlesById,
        publicFiles,
    };
}

module.exports = {
    ARTICLE_ID_PATTERN,
    QIITA_ITEM_ID_PATTERN,
    INLINE_REFERENCE_PATTERN,
    SERIES_START,
    SERIES_END,
    RegistryValidationError,
    articleMarker,
    getArticleMarkers,
    getInlineReferences,
    injectArticleMarker,
    loadPublicationContext,
};

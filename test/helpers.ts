const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const matter: typeof import('gray-matter') = require('gray-matter');

const ARTICLE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ARTICLE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ARTICLE_IGNORED = 'cccccccccccccccccccccccccccccccc';
const ITEM_A = '1111111111111111111a';
const ITEM_B = '2222222222222222222b';

export interface SourceMarkdownOptions {
    articleId: string;
    title: string;
    series?: string | null;
    body?: string;
    tags?: string[];
}

export interface PublicMarkdownOptions {
    itemId: string;
    title: string;
    body?: string;
    isPrivate?: boolean;
    tags?: string[];
}

export interface FixtureOptions {
    includeIgnoredArticle?: boolean;
    alphaSourceTags?: string[];
    betaSourceTags?: string[];
    alphaRemoteTags?: string[];
    betaRemoteTags?: string[];
    betaSeries?: string | null;
}

export interface FixtureManifestArticle {
    article_id: string;
    source: string;
    article_state: string;
    targets: Record<string, { desired: string }>;
}

export interface FixtureManifest {
    schema_version: number;
    articles: FixtureManifestArticle[];
}

export interface FixtureArticleMap extends Record<string, unknown> {
    schema_version: number;
    platform: string;
    qiita_user: string;
    bindings: Record<string, {
        item_id: string;
        binding_state: string;
    }>;
}

export interface Fixture {
    rootDir: string;
    prePublishDir: string;
    publicDir: string;
    manifest: FixtureManifest;
    articleMap: FixtureArticleMap;
    cleanup: () => void;
    readJson: <T = unknown>(relativePath: string) => T;
    writeJson: (relativePath: string, value: unknown) => void;
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sourceMarkdown(options: SourceMarkdownOptions): string {
    const {
        articleId,
        title,
        series = 'Fixture Series',
        body = 'Fixture body.\n',
        tags = ['fixture'],
    } = options;
    return matter.stringify(body, {
        article_id: articleId,
        title,
        series,
        tags,
        local_updated_at: '2026-07-23T00:00:00.000Z',
    });
}

function publicMarkdown(options: PublicMarkdownOptions): string {
    const {
        itemId,
        title,
        body = 'Remote body.\n',
        isPrivate = true,
        tags = ['old'],
    } = options;
    return matter.stringify(body, {
        title,
        tags,
        private: isPrivate,
        updated_at: '2026-07-22T00:00:00.000Z',
        id: itemId,
        organization_url_name: null,
        slide: false,
        ignorePublish: false,
    });
}

function createFixture(options: FixtureOptions = {}): Fixture {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiita-identity-'));
    const prePublishDir = path.join(rootDir, 'pre-publish');
    const publicDir = path.join(rootDir, 'public');
    fs.mkdirSync(prePublishDir);
    fs.mkdirSync(publicDir);

    const manifest: FixtureManifest = {
        schema_version: 1,
        articles: [
            {
                article_id: ARTICLE_A,
                source: 'articles/share/alpha.md',
                article_state: 'active',
                targets: {
                    qiita: {
                        desired: 'published',
                    },
                },
            },
            {
                article_id: ARTICLE_B,
                source: 'articles/qiita/beta.md',
                article_state: 'active',
                targets: {
                    qiita: {
                        desired: 'published',
                    },
                },
            },
        ],
    };
    if (options.includeIgnoredArticle) {
        manifest.articles.push({
            article_id: ARTICLE_IGNORED,
            source: 'articles/zenn/ignored.md',
            article_state: 'active',
            targets: {
                zenn: {
                    desired: 'published',
                },
            },
        });
    }

    const articleMap: FixtureArticleMap = {
        schema_version: 1,
        platform: 'qiita',
        qiita_user: 'fixture-user',
        bindings: {
            [ARTICLE_A]: {
                item_id: ITEM_A,
                binding_state: 'bound',
            },
            [ARTICLE_B]: {
                item_id: ITEM_B,
                binding_state: 'bound',
            },
        },
    };

    writeJson(path.join(prePublishDir, 'manifest.json'), manifest);
    writeJson(path.join(rootDir, 'article-map.json'), articleMap);
    fs.writeFileSync(
        path.join(prePublishDir, 'alpha.md'),
        sourceMarkdown({
            articleId: ARTICLE_A,
            title: 'Alpha title',
            body: `Alpha links to <<<article:${ARTICLE_B}>>>.\n`,
            tags: options.alphaSourceTags,
        }),
        'utf8',
    );
    fs.writeFileSync(
        path.join(prePublishDir, 'beta.md'),
        sourceMarkdown({
            articleId: ARTICLE_B,
            title: 'Beta title',
            series: options.betaSeries === undefined ? 'Fixture Series' : options.betaSeries,
            body: 'Beta body.\n',
            tags: options.betaSourceTags,
        }),
        'utf8',
    );
    fs.writeFileSync(
        path.join(publicDir, 'remote-alpha.md'),
        publicMarkdown({
            itemId: ITEM_A,
            title: 'Old Alpha',
            tags: options.alphaRemoteTags,
        }),
        'utf8',
    );
    fs.writeFileSync(
        path.join(publicDir, 'remote-beta.md'),
        publicMarkdown({
            itemId: ITEM_B,
            title: 'Old Beta',
            tags: options.betaRemoteTags,
        }),
        'utf8',
    );

    return {
        rootDir,
        prePublishDir,
        publicDir,
        manifest,
        articleMap,
        cleanup() {
            fs.rmSync(rootDir, { recursive: true, force: true });
        },
        readJson<T = unknown>(relativePath: string): T {
            return JSON.parse(
                fs.readFileSync(path.join(rootDir, relativePath), 'utf8'),
            ) as T;
        },
        writeJson(relativePath: string, value: unknown): void {
            writeJson(path.join(rootDir, relativePath), value);
        },
    };
}

export interface TestHelpersExports {
    ARTICLE_A: typeof ARTICLE_A;
    ARTICLE_B: typeof ARTICLE_B;
    ARTICLE_IGNORED: typeof ARTICLE_IGNORED;
    ITEM_A: typeof ITEM_A;
    ITEM_B: typeof ITEM_B;
    createFixture: typeof createFixture;
    publicMarkdown: typeof publicMarkdown;
    sourceMarkdown: typeof sourceMarkdown;
}

module.exports = {
    ARTICLE_A,
    ARTICLE_B,
    ARTICLE_IGNORED,
    ITEM_A,
    ITEM_B,
    createFixture,
    publicMarkdown,
    sourceMarkdown,
};

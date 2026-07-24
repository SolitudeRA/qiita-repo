const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const matter = require('gray-matter');
const { buildArticles } = require('../scripts/build-articles');
const {
    planPublicArticles,
    selectBoundTargetTags,
    writePublicArticles,
} = require('../scripts/parse-articles');
const { writeSeriesLinks } = require('../scripts/generate-series-links');
const { publishPlanned } = require('../scripts/publish-articles');
const {
    createPublishProjection,
    normalizePublishBody,
    releaseBoundArticles,
} = require('../scripts/release-articles');
const { preparePull } = require('../scripts/prepare-pull');
const { loadPublicationContext } = require('../scripts/lib/article-registry.ts');
const {
    compareBindingHistory,
    loadBaselineMapFromGit,
    validateBindingHistory,
} = require('../scripts/validate-map-history');
const {
    ARTICLE_A,
    ARTICLE_B,
    ITEM_A,
    ITEM_B,
    createFixture,
    sourceMarkdown,
} = require('./helpers');

function withFixture(options, callback) {
    const fixture = createFixture(options);
    try {
        return callback(fixture);
    } finally {
        fixture.cleanup();
    }
}

function runGitQuiet(rootDir, args) {
    const result = spawnSync('git', args, {
        cwd: rootDir,
        shell: false,
        stdio: 'ignore',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed`);
}

test('ID-first build preserves Qiita IDs, forces public, and generates ID links', () => {
    withFixture({}, ({ rootDir, publicDir }) => {
        const parsed = writePublicArticles({ rootDir });
        assert.equal(parsed.writes.length, 2);
        writeSeriesLinks({ rootDir });

        const alpha = matter(
            fs.readFileSync(path.join(publicDir, 'remote-alpha.md'), 'utf8'),
        );
        assert.equal(alpha.data.id, ITEM_A);
        assert.equal(alpha.data.title, 'Alpha title');
        assert.equal(alpha.data.private, false);
        assert.match(
            alpha.content,
            new RegExp(`blog-project:article-id=${ARTICLE_A}`),
        );
        assert.match(
            alpha.content,
            new RegExp(`https://qiita\\.com/fixture-user/items/${ITEM_B}`),
        );
        assert.match(alpha.content, /Fixture Series シリーズ記事/);
        assert.doesNotMatch(alpha.content, /<<<article:/);
    });
});

test('equivalent bound tags preserve remote display names in source order', () => {
    withFixture(
        {
            alphaSourceTags: [
                'server',
                'nodejs',
                'data_pipeline',
                'home server',
                '日本語',
            ],
            alphaRemoteTags: [
                'Home-Server',
                'Node.js',
                '日本語',
                'Data.Pipeline',
                'Server',
            ],
        },
        ({ rootDir, publicDir }) => {
            buildArticles({ rootDir });
            const alpha = matter(
                fs.readFileSync(
                    path.join(publicDir, 'remote-alpha.md'),
                    'utf8',
                ),
            );
            assert.deepEqual(alpha.data.tags, [
                'Server',
                'Node.js',
                'Data.Pipeline',
                'Home-Server',
                '日本語',
            ]);
        },
    );
});

test('managed markers continue preserving normalized-equivalent remote tag names', () => {
    withFixture(
        {
            alphaSourceTags: ['server', 'nodejs'],
            alphaRemoteTags: ['Server', 'Node.js'],
        },
        ({ rootDir, prePublishDir, publicDir }) => {
            buildArticles({ rootDir });
            fs.writeFileSync(
                path.join(prePublishDir, 'alpha.md'),
                sourceMarkdown({
                    articleId: ARTICLE_A,
                    title: 'Alpha title',
                    body: `Alpha links to <<<article:${ARTICLE_B}>>>.\n`,
                    tags: ['node_js', 'SERVER'],
                }),
                'utf8',
            );

            buildArticles({ rootDir });
            const alpha = matter(fs.readFileSync(
                path.join(publicDir, 'remote-alpha.md'),
                'utf8',
            ));
            assert.match(alpha.content, new RegExp(`article-id=${ARTICLE_A}`));
            assert.deepEqual(alpha.data.tags, ['Node.js', 'Server']);
        },
    );
});

test('real tag additions, removals, and replacements use source tags', () => {
    assert.deepEqual(
        selectBoundTargetTags(
            ['server', 'nodejs', 'observability'],
            ['Server', 'Node.js'],
        ),
        ['server', 'nodejs', 'observability'],
    );
    assert.deepEqual(
        selectBoundTargetTags(['server'], ['Server', 'Node.js']),
        ['server'],
    );
    assert.deepEqual(
        selectBoundTargetTags(
            ['backend', 'nodejs'],
            ['Server', 'Node.js'],
        ),
        ['backend', 'nodejs'],
    );
});

test('ambiguous or invalid tag normalization safely falls back to source tags', () => {
    assert.deepEqual(
        selectBoundTargetTags(
            ['nodejs', 'server'],
            ['Node.js', 'node-js'],
        ),
        ['nodejs', 'server'],
    );
    assert.deepEqual(
        selectBoundTargetTags(
            ['Node.js', 'node_js'],
            ['Node.js', 'Server'],
        ),
        ['Node.js', 'node_js'],
    );
    assert.deepEqual(selectBoundTargetTags(['-'], ['_']), ['-']);
    assert.deepEqual(selectBoundTargetTags(['server'], [null]), ['server']);
});

test('tag matching keeps Japanese punctuation significant', () => {
    assert.deepEqual(
        selectBoundTargetTags(['nodejs'], ['Ｎｏｄｅ．ｊｓ']),
        ['Ｎｏｄｅ．ｊｓ'],
    );
    assert.deepEqual(
        selectBoundTargetTags(
            ['サーバー・運用', 'Ｎｏｄｅ．ｊｓ'],
            ['サーバー運用', 'Node.js'],
        ),
        ['サーバー・運用', 'Ｎｏｄｅ．ｊｓ'],
    );
});

test('the checked-in 11-article corpus builds end-to-end against pulled targets', () => {
    const repositoryRoot = path.join(__dirname, '..');
    const rootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qiita-corpus-'));
    try {
        fs.cpSync(
            path.join(repositoryRoot, 'pre-publish'),
            path.join(rootDir, 'pre-publish'),
            { recursive: true },
        );
        fs.copyFileSync(
            path.join(repositoryRoot, 'article-map.json'),
            path.join(rootDir, 'article-map.json'),
        );
        const before = loadPublicationContext({
            rootDir,
            requirePublicTargets: false,
        });
        assert.equal(before.articles.length, 11);

        const publicDir = path.join(rootDir, 'public');
        fs.mkdirSync(publicDir);
        for (const article of before.articles) {
            fs.writeFileSync(
                path.join(publicDir, `${article.mapEntry.item_id}.md`),
                matter.stringify('Pulled remote body.\n', {
                    title: 'Pulled title',
                    tags: ['old'],
                    private: true,
                    updated_at: '2026-07-22T00:00:00.000Z',
                    id: article.mapEntry.item_id,
                    organization_url_name: null,
                    slide: false,
                    ignorePublish: false,
                }),
                'utf8',
            );
        }

        const result = buildArticles({ rootDir });
        assert.deepEqual(result, { parsed: 11, linked: 11 });
        const after = loadPublicationContext({
            rootDir,
            requirePublicTargets: true,
        });
        for (const article of after.articles) {
            assert.equal(article.target.data.id, article.mapEntry.item_id);
            assert.equal(article.target.data.private, false);
            assert.match(
                article.target.content,
                new RegExp(`blog-project:article-id=${article.articleId}`),
            );
            assert.doesNotMatch(article.target.content, /<<<article:/);
        }
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('checked-in guide #1 keeps the introduction heading before its opening paragraph', () => {
    const source = matter(fs.readFileSync(
        path.join(
            __dirname,
            '..',
            'pre-publish',
            'ホームサーバー完全構築ガイド #1 OS導入と基本設定.md',
        ),
        'utf8',
    ));
    const headingIndex = source.content.indexOf('# **はじめに**');
    const openingIndex = source.content.indexOf(
        '前回の記事では、ハードウェア選定と全体的なサービスアーキテクチャについて解説しました。',
    );
    assert.notEqual(headingIndex, -1);
    assert.notEqual(openingIndex, -1);
    assert.ok(
        headingIndex < openingIndex,
        'guide #1 introduction heading must precede the opening paragraph',
    );
});

test('title and source-path rename retain the same mapped Qiita target', () => {
    withFixture({}, ({ rootDir, prePublishDir, manifest, writeJson }) => {
        const oldPath = path.join(prePublishDir, 'alpha.md');
        const renamedPath = path.join(prePublishDir, 'renamed-alpha.md');
        fs.renameSync(oldPath, renamedPath);
        fs.writeFileSync(
            renamedPath,
            sourceMarkdown({
                articleId: ARTICLE_A,
                title: 'Completely renamed title',
                body: 'Renamed body.\n',
            }),
            'utf8',
        );
        manifest.articles[0].source = 'articles/share/renamed-alpha.md';
        writeJson('pre-publish/manifest.json', manifest);

        const plan = planPublicArticles({ rootDir });
        const alphaWrite = plan.writes.find((write) => write.articleId === ARTICLE_A);
        assert.equal(alphaWrite.itemId, ITEM_A);
        assert.equal(alphaWrite.targetFile, 'remote-alpha.md');

        writePublicArticles({ rootDir });
        const output = matter(fs.readFileSync(alphaWrite.targetPath, 'utf8'));
        assert.equal(output.data.id, ITEM_A);
        assert.equal(output.data.title, 'Completely renamed title');
    });
});

test('series:null and manifest entries without a Qiita target are accepted', () => {
    withFixture(
        { betaSeries: null, includeIgnoredArticle: true },
        ({ rootDir, prePublishDir }) => {
            fs.writeFileSync(
                path.join(prePublishDir, 'ignored.md'),
                'This non-Qiita source is intentionally ignored.\n',
                'utf8',
            );
            const context = loadPublicationContext({
                rootDir,
                requirePublicTargets: true,
            });
            assert.equal(context.articles.length, 2);
            assert.equal(context.articlesById.has(ARTICLE_B), true);
        },
    );
});

test('missing or mismatched source article_id fails before writing public files', () => {
    withFixture({}, ({ rootDir, prePublishDir, publicDir }) => {
        const targetPath = path.join(publicDir, 'remote-alpha.md');
        const before = fs.readFileSync(targetPath, 'utf8');
        fs.writeFileSync(
            path.join(prePublishDir, 'alpha.md'),
            sourceMarkdown({
                articleId: ARTICLE_B,
                title: 'Wrong identity',
            }),
            'utf8',
        );

        assert.throws(
            () => writePublicArticles({ rootDir }),
            /front matter article_id が manifest と一致しません/,
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);

        const withoutId = matter.stringify('No id.\n', {
            title: 'Missing identity',
            tags: ['fixture'],
            local_updated_at: '2026-07-23T00:00:00.000Z',
        });
        fs.writeFileSync(path.join(prePublishDir, 'alpha.md'), withoutId, 'utf8');
        assert.throws(
            () => planPublicArticles({ rootDir }),
            /front matter article_id は小文字 32hex で必須です/,
        );
    });
});

test('missing source, duplicate IDs, and duplicate projected basenames fail closed', () => {
    withFixture({}, ({ rootDir, prePublishDir, manifest, writeJson }) => {
        fs.rmSync(path.join(prePublishDir, 'alpha.md'));
        assert.throws(
            () => planPublicArticles({ rootDir }),
            /active\/published Qiita source が見つかりません/,
        );

        fs.writeFileSync(
            path.join(prePublishDir, 'alpha.md'),
            sourceMarkdown({ articleId: ARTICLE_A, title: 'Alpha' }),
            'utf8',
        );
        manifest.articles[1].article_id = ARTICLE_A;
        writeJson('pre-publish/manifest.json', manifest);
        assert.throws(() => planPublicArticles({ rootDir }), /article_id が重複/);

        manifest.articles[1].article_id = ARTICLE_B;
        manifest.articles[1].source = 'articles/qiita/alpha.md';
        writeJson('pre-publish/manifest.json', manifest);
        assert.throws(
            () => planPublicArticles({ rootDir }),
            /source basename が重複/,
        );
    });
});

test('map target drift and missing pulled target fail before writes', () => {
    withFixture({}, ({ rootDir, publicDir, articleMap, writeJson }) => {
        const targetPath = path.join(publicDir, 'remote-alpha.md');
        const before = fs.readFileSync(targetPath, 'utf8');
        articleMap.bindings[ARTICLE_A].item_id = '3333333333333333333c';
        writeJson('article-map.json', articleMap);
        assert.throws(
            () => writePublicArticles({ rootDir }),
            /Qiita target が public にありません/,
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);

        articleMap.bindings[ARTICLE_A].item_id = ITEM_A;
        writeJson('article-map.json', articleMap);
        fs.rmSync(targetPath);
        assert.throws(
            () => planPublicArticles({ rootDir }),
            /Qiita target が public にありません/,
        );
    });
});

test('legacy title references and malformed series markers fail before writes', () => {
    withFixture({}, ({ rootDir, prePublishDir, publicDir }) => {
        const sourcePath = path.join(prePublishDir, 'alpha.md');
        const targetPath = path.join(publicDir, 'remote-alpha.md');
        const before = fs.readFileSync(targetPath, 'utf8');
        fs.writeFileSync(
            sourcePath,
            sourceMarkdown({
                articleId: ARTICLE_A,
                title: 'Alpha',
                body: 'See <<<Beta title>>>.\n',
            }),
            'utf8',
        );
        assert.throws(
            () => writePublicArticles({ rootDir }),
            /タイトル参照 .* は禁止されています/,
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);

        fs.writeFileSync(
            sourcePath,
            sourceMarkdown({
                articleId: ARTICLE_A,
                title: 'Alpha',
                body: '<!-- START_SERIES -->\nBroken.\n',
            }),
            'utf8',
        );
        assert.throws(
            () => writePublicArticles({ rootDir }),
            /series marker が不正です/,
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
    });
});

test('duplicate and drifted body markers fail closed', () => {
    withFixture({}, ({ rootDir, publicDir }) => {
        const alphaPath = path.join(publicDir, 'remote-alpha.md');
        const betaPath = path.join(publicDir, 'remote-beta.md');
        const duplicate = `<!-- blog-project:article-id=${ARTICLE_A} -->\n`
            + `<!-- blog-project:article-id=${ARTICLE_A} -->\n`;
        const alpha = matter(fs.readFileSync(alphaPath, 'utf8'));
        fs.writeFileSync(alphaPath, matter.stringify(duplicate, alpha.data), 'utf8');
        assert.throws(
            () => planPublicArticles({ rootDir }),
            /article-id marker が複数あります/,
        );

        fs.writeFileSync(alphaPath, matter.stringify('Remote.\n', alpha.data), 'utf8');
        const beta = matter(fs.readFileSync(betaPath, 'utf8'));
        fs.writeFileSync(
            betaPath,
            matter.stringify(
                `<!-- blog-project:article-id=${ARTICLE_A} -->\nRemote.\n`,
                beta.data,
            ),
            'utf8',
        );
        assert.throws(
            () => planPublicArticles({ rootDir }),
            /article-id marker が map と異なる Qiita target にあります/,
        );
    });
});

test('historical bindings are immutable while initial map introduction is allowed', () => {
    withFixture({}, ({ rootDir, articleMap, writeJson }) => {
        const baselineMap = structuredClone(articleMap);
        const unchanged = validateBindingHistory({ rootDir, baselineMap });
        assert.equal(unchanged.checkedBindings, 2);
        assert.equal(unchanged.initialIntroduction, false);

        articleMap.bindings[ARTICLE_A].item_id = '3333333333333333333c';
        writeJson('article-map.json', articleMap);
        assert.throws(
            () => validateBindingHistory({ rootDir, baselineMap }),
            /既存 binding の item_id 変更は禁止されています/,
        );

        articleMap.bindings[ARTICLE_A].item_id = ITEM_A;
        articleMap.qiita_user = 'different-user';
        writeJson('article-map.json', articleMap);
        assert.throws(
            () => validateBindingHistory({ rootDir, baselineMap }),
            /article-map\.qiita_user の変更は禁止されています/,
        );

        const initial = compareBindingHistory(articleMap, null);
        assert.equal(initial.initialIntroduction, true);
    });
});

test('Git baseline loading only allows a missing map and fails closed otherwise', () => {
    const rootDir = process.cwd();
    const missingMapRunner = (_runnerRoot, args) => {
        if (args[0] === 'cat-file' && args[2]?.endsWith('^{commit}')) {
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    assert.equal(
        loadBaselineMapFromGit({
            rootDir,
            baselineRef: 'base-revision',
            gitRunner: missingMapRunner,
        }),
        null,
    );

    assert.throws(
        () => loadBaselineMapFromGit({
            rootDir,
            baselineRef: 'missing-revision',
            gitRunner: () => ({
                status: 128,
                stdout: '',
                stderr: 'fatal: invalid object name',
            }),
        }),
        /baseline commit .* に失敗しました/,
    );

    const malformedRunner = (_runnerRoot, args) => {
        if (args[0] === 'show') {
            return { status: 0, stdout: '{not-json', stderr: '' };
        }
        if (args[0] === 'ls-tree') {
            return { status: 0, stdout: 'article-map.json\0', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    assert.throws(
        () => loadBaselineMapFromGit({
            rootDir,
            baselineRef: 'base-revision',
            gitRunner: malformedRunner,
        }),
        /baseline map を JSON として解析できません/,
    );

    const treeErrorRunner = (_runnerRoot, args) => {
        if (args[0] === 'cat-file') {
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'fatal: object is corrupt' };
    };
    assert.throws(
        () => loadBaselineMapFromGit({
            rootDir,
            baselineRef: 'base-revision',
            gitRunner: treeErrorRunner,
        }),
        /baseline tree .* に失敗しました/,
    );
});

test('default Git runner reads the real repository HEAD', () => {
    const repositoryRoot = path.join(__dirname, '..');
    const result = validateBindingHistory({
        rootDir: repositoryRoot,
        baselineRef: 'HEAD',
    });
    assert.equal(result.baselineRef, 'HEAD');
    assert.equal(
        result.initialIntroduction || result.checkedBindings >= 0,
        true,
    );
});

test('a deleted historical map cannot be reintroduced with rebound IDs', () => {
    withFixture({}, ({ rootDir, articleMap, writeJson }) => {
        runGitQuiet(rootDir, ['init']);
        runGitQuiet(rootDir, ['config', 'user.email', 'fixture@example.invalid']);
        runGitQuiet(rootDir, ['config', 'user.name', 'Fixture']);
        runGitQuiet(rootDir, ['add', '--', 'article-map.json']);
        runGitQuiet(rootDir, ['commit', '-m', 'add article map']);
        fs.rmSync(path.join(rootDir, 'article-map.json'));
        runGitQuiet(rootDir, ['add', '--', 'article-map.json']);
        runGitQuiet(rootDir, ['commit', '-m', 'delete article map']);

        articleMap.bindings[ARTICLE_A].item_id = '3333333333333333333c';
        writeJson('article-map.json', articleMap);
        assert.throws(
            () => validateBindingHistory({
                rootDir,
                baselineRef: 'HEAD',
            }),
            /既存 binding の item_id 変更は禁止されています/,
        );
    });

    withFixture({}, ({ rootDir }) => {
        runGitQuiet(rootDir, ['init']);
        runGitQuiet(rootDir, ['config', 'user.email', 'fixture@example.invalid']);
        runGitQuiet(rootDir, ['config', 'user.name', 'Fixture']);
        runGitQuiet(rootDir, ['commit', '--allow-empty', '-m', 'history without map']);
        const result = validateBindingHistory({
            rootDir,
            baselineRef: 'HEAD',
        });
        assert.equal(result.initialIntroduction, true);
        assert.equal(result.checkedBindings, 0);
    });
});

test('retiring, retired, and withdrawn lifecycle requests are explicitly unsupported', () => {
    for (const [articleState, desired] of [
        ['retiring', 'published'],
        ['retired', 'published'],
        ['active', 'withdrawn'],
    ]) {
        withFixture({}, ({ rootDir, manifest, writeJson }) => {
            manifest.articles[0].article_state = articleState;
            manifest.articles[0].targets.qiita.desired = desired;
            writeJson('pre-publish/manifest.json', manifest);
            assert.throws(
                () => planPublicArticles({ rootDir }),
                /この切片では未対応です/,
            );
        });
    }
});

test('publishing invokes only mapped basenames and never an all/force path', () => {
    withFixture({}, ({ rootDir }) => {
        const calls = [];
        const result = publishPlanned({
            rootDir,
            runner: (_runnerRoot, basename, target) => {
                calls.push({ basename, target });
            },
        });

        assert.equal(result.targets.length, 2);
        assert.deepEqual(
            calls.map((call) => call.basename).sort(),
            ['remote-alpha', 'remote-beta'],
        );
        assert.equal(
            calls.some((call) => /--all|--force/.test(call.basename)),
            false,
        );
        assert.deepEqual(
            calls.map((call) => call.target.itemId).sort(),
            [ITEM_A, ITEM_B].sort(),
        );
    });
});

test('pull preparation removes only the generated public directory', () => {
    const rootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qiita-reset-'));
    try {
        const publicDir = path.join(rootDir, 'public');
        fs.mkdirSync(path.join(publicDir, '.remote'), { recursive: true });
        fs.writeFileSync(path.join(publicDir, 'stale.md'), 'stale\n', 'utf8');
        fs.writeFileSync(
            path.join(publicDir, '.remote', 'stale.md'),
            'stale remote\n',
            'utf8',
        );
        fs.writeFileSync(path.join(rootDir, 'keep.txt'), 'keep\n', 'utf8');

        const result = preparePull({ rootDir });
        assert.equal(result.publicDir, publicDir);
        assert.deepEqual(fs.readdirSync(publicDir), []);
        assert.equal(
            fs.readFileSync(path.join(rootDir, 'keep.txt'), 'utf8'),
            'keep\n',
        );
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('pull preparation rejects a public symlink escaping the repository', (t) => {
    const rootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qiita-link-root-'));
    const outsideDir = fs.mkdtempSync(
        path.join(require('node:os').tmpdir(), 'qiita-link-outside-'),
    );
    const publicPath = path.join(rootDir, 'public');
    const sentinelPath = path.join(outsideDir, 'sentinel.txt');
    fs.writeFileSync(sentinelPath, 'keep\n', 'utf8');
    try {
        try {
            fs.symlinkSync(
                outsideDir,
                publicPath,
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        } catch (error) {
            t.skip(`symlink creation is unavailable: ${error.code || error.message}`);
            return;
        }

        assert.throws(
            () => preparePull({ rootDir }),
            /symbolic link/,
        );
        assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep\n');
    } finally {
        if (fs.existsSync(publicPath) && fs.lstatSync(publicPath).isSymbolicLink()) {
            fs.unlinkSync(publicPath);
        }
        fs.rmSync(rootDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('pull preparation rejects a symlink inside public', (t) => {
    const rootDir = fs.mkdtempSync(
        path.join(require('node:os').tmpdir(), 'qiita-inner-link-root-'),
    );
    const outsideDir = fs.mkdtempSync(
        path.join(require('node:os').tmpdir(), 'qiita-inner-link-outside-'),
    );
    const publicDir = path.join(rootDir, 'public');
    const remotePath = path.join(publicDir, '.remote');
    const sentinelPath = path.join(outsideDir, 'sentinel.md');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(sentinelPath, 'keep\n', 'utf8');
    try {
        try {
            fs.symlinkSync(
                outsideDir,
                remotePath,
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        } catch (error) {
            t.skip(`symlink creation is unavailable: ${error.code || error.message}`);
            return;
        }

        assert.throws(
            () => preparePull({ rootDir }),
            /symbolic link/,
        );
        assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep\n');
    } finally {
        if (fs.existsSync(remotePath) && fs.lstatSync(remotePath).isSymbolicLink()) {
            fs.unlinkSync(remotePath);
        }
        fs.rmSync(rootDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('pull preparation rejects a non-directory public path', () => {
    const rootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qiita-file-root-'));
    const publicPath = path.join(rootDir, 'public');
    try {
        fs.writeFileSync(publicPath, 'do not delete\n', 'utf8');
        assert.throws(
            () => preparePull({ rootDir }),
            /directory ではない/,
        );
        assert.equal(fs.readFileSync(publicPath, 'utf8'), 'do not delete\n');
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('pull preparation rejects unexpected entries inside public', () => {
    const rootDir = fs.mkdtempSync(
        path.join(require('node:os').tmpdir(), 'qiita-unexpected-root-'),
    );
    const publicDir = path.join(rootDir, 'public');
    try {
        fs.mkdirSync(publicDir);
        fs.writeFileSync(path.join(publicDir, 'notes.txt'), 'do not delete\n', 'utf8');
        assert.throws(
            () => preparePull({ rootDir }),
            /想定外の entry/,
        );
        assert.equal(
            fs.readFileSync(path.join(publicDir, 'notes.txt'), 'utf8'),
            'do not delete\n',
        );
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('first bound release publishes all 11 pulled targets without identity markers', () => {
    const repositoryRoot = path.join(__dirname, '..');
    const rootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qiita-release-'));
    try {
        fs.cpSync(
            path.join(repositoryRoot, 'pre-publish'),
            path.join(rootDir, 'pre-publish'),
            { recursive: true },
        );
        fs.copyFileSync(
            path.join(repositoryRoot, 'article-map.json'),
            path.join(rootDir, 'article-map.json'),
        );
        const sourceContext = loadPublicationContext({
            rootDir,
            requirePublicTargets: false,
        });
        const publicDir = path.join(rootDir, 'public');
        fs.mkdirSync(publicDir);
        for (const article of sourceContext.articles) {
            fs.writeFileSync(
                path.join(publicDir, `${article.mapEntry.item_id}.md`),
                matter.stringify(article.sourceBody, {
                    title: article.sourceData.title,
                    tags: article.sourceData.tags,
                    private: false,
                    updated_at: '2026-07-22T00:00:00.000Z',
                    id: article.mapEntry.item_id,
                    organization_url_name: null,
                    slide: false,
                    ignorePublish: false,
                }),
                'utf8',
            );
        }

        const calls = [];
        const result = releaseBoundArticles({
            rootDir,
            runner: (_runnerRoot, basename, target) => {
                calls.push({ basename, target });
            },
        });
        assert.equal(result.changed, 11);
        assert.equal(result.unchanged, 0);
        assert.equal(calls.length, 11);
        assert.equal(new Set(calls.map((call) => call.target.articleId)).size, 11);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('a built target with only local_updated_at changed publishes nothing', () => {
    withFixture({}, ({ rootDir, prePublishDir }) => {
        buildArticles({ rootDir });
        const sourcePath = path.join(prePublishDir, 'alpha.md');
        const source = matter(fs.readFileSync(sourcePath, 'utf8'));
        source.data.local_updated_at = '2026-07-24T12:34:56.000Z';
        fs.writeFileSync(
            sourcePath,
            matter.stringify(source.content, source.data),
            'utf8',
        );

        const calls = [];
        const result = releaseBoundArticles({
            rootDir,
            runner: (...args) => calls.push(args),
        });
        assert.equal(result.changed, 0);
        assert.equal(result.unchanged, 2);
        assert.deepEqual(calls, []);
    });
});

test('Qiita-collapsed redundant blank lines publish nothing', () => {
    withFixture({}, ({ rootDir, prePublishDir, publicDir }) => {
        const sourcePath = path.join(prePublishDir, 'alpha.md');
        fs.writeFileSync(
            sourcePath,
            sourceMarkdown({
                articleId: ARTICLE_A,
                title: 'Alpha title',
                body: 'Alpha first.\n\n\nAlpha second.\n',
            }),
            'utf8',
        );
        buildArticles({ rootDir });

        const targetPath = path.join(publicDir, 'remote-alpha.md');
        const pulled = matter(fs.readFileSync(targetPath, 'utf8'));
        pulled.content = pulled.content.replace(
            'Alpha first.\n\n\nAlpha second.',
            'Alpha first.\n\nAlpha second.',
        );
        fs.writeFileSync(
            targetPath,
            matter.stringify(pulled.content, pulled.data),
            'utf8',
        );

        const calls = [];
        const result = releaseBoundArticles({
            rootDir,
            runner: (...args) => calls.push(args),
        });
        assert.equal(result.changed, 0);
        assert.equal(result.unchanged, 2);
        assert.deepEqual(calls, []);
    });
});

test('a pure tag reorder publishes nothing', () => {
    withFixture(
        {
            alphaSourceTags: ['nodejs', 'server'],
            alphaRemoteTags: ['Node.js', 'Server'],
        },
        ({ rootDir, prePublishDir }) => {
            buildArticles({ rootDir });
            fs.writeFileSync(
                path.join(prePublishDir, 'alpha.md'),
                sourceMarkdown({
                    articleId: ARTICLE_A,
                    title: 'Alpha title',
                    body: `Alpha links to <<<article:${ARTICLE_B}>>>.\n`,
                    tags: ['server', 'nodejs'],
                }),
                'utf8',
            );

            const calls = [];
            const result = releaseBoundArticles({
                rootDir,
                runner: (...args) => calls.push(args),
            });
            assert.equal(result.changed, 0);
            assert.equal(result.unchanged, 2);
            assert.deepEqual(calls, []);
        },
    );
});

test('one body edit publishes only its bound target', () => {
    withFixture({}, ({ rootDir, prePublishDir }) => {
        buildArticles({ rootDir });
        fs.writeFileSync(
            path.join(prePublishDir, 'alpha.md'),
            sourceMarkdown({
                articleId: ARTICLE_A,
                title: 'Alpha title',
                body: 'Changed Alpha body.\n',
            }),
            'utf8',
        );

        const calls = [];
        const result = releaseBoundArticles({
            rootDir,
            runner: (_runnerRoot, basename, target) => {
                calls.push({ basename, target });
            },
        });
        assert.equal(result.changed, 1);
        assert.equal(result.unchanged, 1);
        assert.deepEqual(calls.map((call) => call.target.articleId), [ARTICLE_A]);
        assert.deepEqual(calls.map((call) => call.basename), ['remote-alpha']);
    });
});

test('one tag edit publishes only its bound target', () => {
    withFixture({}, ({ rootDir, prePublishDir }) => {
        buildArticles({ rootDir });
        fs.writeFileSync(
            path.join(prePublishDir, 'alpha.md'),
            sourceMarkdown({
                articleId: ARTICLE_A,
                title: 'Alpha title',
                body: `Alpha links to <<<article:${ARTICLE_B}>>>.\n`,
                tags: ['fixture', 'new-tag'],
            }),
            'utf8',
        );

        const calls = [];
        const result = releaseBoundArticles({
            rootDir,
            runner: (_runnerRoot, basename, target) => {
                calls.push({ basename, target });
            },
        });
        assert.equal(result.changed, 1);
        assert.equal(result.unchanged, 1);
        assert.deepEqual(calls.map((call) => call.target.articleId), [ARTICLE_A]);
        assert.deepEqual(calls.map((call) => call.basename), ['remote-alpha']);
    });
});

test('body projection normalizes transport and redundant blank lines', () => {
    assert.equal(
        normalizePublishBody('\r\n \r\nAlpha\r\n\r\n\r\nBeta\r\n\t\r\n'),
        'Alpha\n\nBeta',
    );
    assert.equal(
        normalizePublishBody('Alpha\n\n\nBeta\n'),
        normalizePublishBody('Alpha\n\nBeta\n'),
    );
    assert.notEqual(
        normalizePublishBody('Alpha\n\nBeta\n'),
        normalizePublishBody('Alpha\nBeta\n'),
    );
    assert.notEqual(
        normalizePublishBody('```\nAlpha\n\n\nBeta\n```\n'),
        normalizePublishBody('```\nAlpha\n\nBeta\n```\n'),
    );
});

test('publish projection ignores transport metadata and serialization edges', () => {
    const article = (data, content) => ({
        articleId: ARTICLE_A,
        mapEntry: { item_id: ITEM_A },
        target: { data, content },
    });
    const publishFields = {
        title: 'Alpha title',
        tags: ['Fixture', 'Node.js'],
        private: false,
        organization_url_name: null,
        slide: false,
    };
    const before = createPublishProjection(article(
        {
            ...publishFields,
            updated_at: '2026-07-22T00:00:00.000Z',
            id: ITEM_A,
            ignorePublish: true,
        },
        '\r\nAlpha\r\n\r\nBeta\r\n',
    ));
    const after = createPublishProjection(article(
        {
            ignorePublish: false,
            id: ITEM_B,
            updated_at: '2026-07-24T00:00:00.000Z',
            ...publishFields,
        },
        '\nAlpha\n\nBeta\n\n',
    ));
    assert.deepEqual(after, before);
    assert.notDeepEqual(
        createPublishProjection(article(
            { ...publishFields, tags: ['Fixture', 'nodejs'] },
            'Alpha\n\nBeta\n',
        )),
        before,
    );
});

test('build-time target drift fails before the first publish runner call', () => {
    withFixture({}, ({ rootDir, publicDir }) => {
        buildArticles({ rootDir });
        const calls = [];
        assert.throws(
            () => releaseBoundArticles({
                rootDir,
                runner: (...args) => calls.push(args),
                builder: (options) => {
                    const result = buildArticles(options);
                    fs.renameSync(
                        path.join(publicDir, 'remote-alpha.md'),
                        path.join(publicDir, 'renamed-alpha.md'),
                    );
                    return result;
                },
            }),
            /articleId\/itemId\/basename の集合が変化しました/,
        );
        assert.deepEqual(calls, []);
    });
});

test('incomplete build coverage fails before the first publish runner call', () => {
    withFixture({}, ({ rootDir }) => {
        const calls = [];
        assert.throws(
            () => releaseBoundArticles({
                rootDir,
                runner: (...args) => calls.push(args),
                builder: () => ({ parsed: 1, linked: 2 }),
            }),
            /build が全 binding を処理しませんでした/,
        );
        assert.deepEqual(calls, []);
    });
});

test('workflow uses the push base revision and has no bulk or forced publish path', () => {
    const repositoryRoot = path.join(__dirname, '..');
    const packageJson = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'package.json'),
        'utf8',
    ));
    const workflow = fs.readFileSync(
        path.join(repositoryRoot, '.github', 'workflows', 'publish_articles.yml'),
        'utf8',
    );
    const publishScript = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'publish-articles.js'),
        'utf8',
    );
    const releaseScript = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'release-articles.js'),
        'utf8',
    );
    assert.match(workflow, /BASELINE_REF: \$\{\{ github\.event\.before \}\}/);
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /run: npm test/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /run: npm run prepare:pull/);
    assert.match(workflow, /run: npx qiita pull --force/);
    assert.match(workflow, /run: npm run release:bound/);
    assert.doesNotMatch(workflow, /run: npm run publish:planned/);
    assert.equal(packageJson.scripts['release:bound'], 'node scripts/release-articles.js');
    assert.equal(
        packageJson.scripts['prepare:pull'],
        'node scripts/prepare-pull.js',
    );
    assert.equal(Object.hasOwn(packageJson.scripts, 'publish:planned'), false);
    assert.doesNotMatch(publishScript, /require\.main\s*===\s*module/);
    assert.doesNotMatch(
        workflow,
        /npx\s+qiita\s+publish[^\r\n]*(?:--all|--force)/,
    );
    assert.doesNotMatch(workflow, /sync-remote-to-public/);
    assert.doesNotMatch(publishScript, /['"]--(?:all|force)['"]/);
    assert.doesNotMatch(releaseScript, /['"]--(?:all|force)['"]/);
    const resetIndex = workflow.indexOf('run: npm run prepare:pull');
    const pullIndex = workflow.indexOf('run: npx qiita pull --force');
    const validateIndex = workflow.indexOf('run: npm run validate', pullIndex);
    const releaseIndex = workflow.indexOf('run: npm run release:bound');
    assert.ok(resetIndex < pullIndex);
    assert.ok(pullIndex < validateIndex);
    assert.ok(validateIndex < releaseIndex);
});

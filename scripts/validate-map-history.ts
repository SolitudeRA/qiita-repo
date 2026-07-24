import type {
    ArticleMapBinding,
    ArticleRegistryExports,
    PublicationContext,
    RootDirOptions,
    UnknownRecord,
} from './lib/article-registry.ts';

const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const {
    ARTICLE_ID_PATTERN,
    QIITA_ITEM_ID_PATTERN,
    RegistryValidationError,
    loadPublicationContext,
} = require('./lib/article-registry.ts') as ArticleRegistryExports;

export interface GitRunnerResult {
    error?: Error;
    signal?: NodeJS.Signals | null;
    status: number | null;
    stdout: string;
    stderr: string;
}

export type GitRunner = (rootDir: string, args: string[]) => GitRunnerResult;

interface HistoricalBinding extends UnknownRecord {
    binding_state: string;
    item_id: string;
}

interface HistoricalArticleMap extends UnknownRecord {
    schema_version: 1;
    platform: 'qiita';
    qiita_user: string;
    bindings: Record<string, HistoricalBinding>;
}

export interface BindingHistoryComparison {
    checkedBindings: number;
    initialIntroduction: boolean;
}

interface LoadBaselineMapOptions {
    rootDir: string;
    baselineRef: string;
    gitRunner?: GitRunner;
}

interface ValidateBindingHistoryOptions extends RootDirOptions {
    baselineRef?: string;
    baselineMap?: unknown;
    gitRunner?: GitRunner;
}

export interface BindingHistoryResult extends BindingHistoryComparison {
    context: PublicationContext;
    baselineRef: string;
}

function isPlainObject(value: unknown): value is UnknownRecord {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
}

function defaultGitRunner(rootDir: string, args: string[]): GitRunnerResult {
    // Codex の Windows sandbox では child process の pipe capture が
    // EPERM になるため、専用一時ファイルの fd を使って同じ出力を捕捉する。
    const captureDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qiita-map-history-'),
    );
    const stdoutPath = path.join(captureDir, 'stdout');
    const stderrPath = path.join(captureDir, 'stderr');
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;

    try {
        stdoutFd = fs.openSync(stdoutPath, 'wx');
        stderrFd = fs.openSync(stderrPath, 'wx');
        const result = spawnSync('git', args, {
            cwd: rootDir,
            shell: false,
            stdio: ['ignore', stdoutFd, stderrFd],
        });
        fs.closeSync(stdoutFd);
        stdoutFd = undefined;
        fs.closeSync(stderrFd);
        stderrFd = undefined;

        return {
            error: result.error,
            signal: result.signal,
            status: result.status,
            stdout: fs.readFileSync(stdoutPath, 'utf8'),
            stderr: fs.readFileSync(stderrPath, 'utf8'),
        };
    } finally {
        if (stdoutFd !== undefined) {
            fs.closeSync(stdoutFd);
        }
        if (stderrFd !== undefined) {
            fs.closeSync(stderrFd);
        }
        fs.rmSync(captureDir, { recursive: true, force: true });
    }
}

function assertGitSuccess(result: GitRunnerResult, operation: string): void {
    if (result.error) {
        throw new Error(`${operation} を実行できません: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`${operation} に失敗しました${detail ? `: ${detail}` : ''}`);
    }
}

function loadBaselineMapFromGit(
    options: LoadBaselineMapOptions,
): unknown | null {
    const {
        rootDir,
        baselineRef,
        gitRunner = defaultGitRunner,
    } = options;

    const commitCheck = gitRunner(rootDir, ['cat-file', '-e', `${baselineRef}^{commit}`]);
    assertGitSuccess(commitCheck, `baseline commit ${baselineRef} の確認`);

    const treeResult = gitRunner(
        rootDir,
        ['ls-tree', '-z', '--name-only', baselineRef, '--', 'article-map.json'],
    );
    assertGitSuccess(treeResult, `baseline tree ${baselineRef} の確認`);
    const treeEntries = treeResult.stdout.split('\0').filter(Boolean);
    let mapRef = baselineRef;
    if (!treeEntries.includes('article-map.json')) {
        const historyResult = gitRunner(rootDir, [
            'log',
            '-n',
            '1',
            '--format=%H',
            '--full-history',
            '--diff-filter=d',
            baselineRef,
            '--',
            'article-map.json',
        ]);
        assertGitSuccess(
            historyResult,
            `baseline ${baselineRef} から article-map.json の履歴検索`,
        );
        const historicalRefs = historyResult.stdout
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean);
        if (historicalRefs.length === 0) {
            // baseline から到達可能な履歴に map が一度もない場合だけ初回導入を許可する。
            return null;
        }
        if (historicalRefs.length !== 1
            || !/^[0-9a-f]{40,64}$/.test(historicalRefs[0])) {
            throw new Error(
                `article-map.json の履歴検索結果が不正です: `
                + historyResult.stdout.trim(),
            );
        }
        [mapRef] = historicalRefs;

        const historicalTree = gitRunner(
            rootDir,
            ['ls-tree', '-z', '--name-only', mapRef, '--', 'article-map.json'],
        );
        assertGitSuccess(
            historicalTree,
            `historical map tree ${mapRef} の確認`,
        );
        const historicalEntries = historicalTree.stdout.split('\0').filter(Boolean);
        if (!historicalEntries.includes('article-map.json')) {
            throw new Error(
                `履歴検索で見つけた ${mapRef} に article-map.json がありません`,
            );
        }
    }

    const showResult = gitRunner(rootDir, ['show', `${mapRef}:article-map.json`]);
    assertGitSuccess(showResult, `baseline map (${mapRef}:article-map.json) の読み込み`);
    try {
        return JSON.parse(showResult.stdout);
    } catch (error) {
        throw new Error(
            `baseline map を JSON として解析できません: `
            + (error instanceof Error ? error.message : String(error)),
        );
    }
}

function validateBaselineMapShape(
    baselineMap: unknown,
    errors: string[],
): baselineMap is HistoricalArticleMap {
    if (!isPlainObject(baselineMap)
        || baselineMap.schema_version !== 1
        || baselineMap.platform !== 'qiita'
        || typeof baselineMap.qiita_user !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(baselineMap.qiita_user)
        || !isPlainObject(baselineMap.bindings)) {
        errors.push('baseline article-map.json のスキーマが不正です');
        return false;
    }

    const itemIds = new Set<string>();
    for (const [articleId, binding] of Object.entries(baselineMap.bindings)) {
        if (!ARTICLE_ID_PATTERN.test(articleId)) {
            errors.push(`baseline map の article_id が不正です: ${articleId}`);
        }
        if (!isPlainObject(binding)) {
            errors.push(`baseline map の binding が不正です: ${articleId}`);
            continue;
        }
        const itemId = binding.item_id;
        if (typeof itemId !== 'string' || !QIITA_ITEM_ID_PATTERN.test(itemId)) {
            errors.push(`baseline map の item_id が不正です: ${articleId}`);
        } else if (itemIds.has(itemId)) {
            errors.push(`baseline map の item_id が重複しています: ${itemId}`);
        } else {
            itemIds.add(itemId);
        }
        if (binding.binding_state !== 'bound') {
            errors.push(`baseline map の binding_state が不正です: ${articleId}`);
        }
    }
    return errors.length === 0;
}

function compareBindingHistory(
    currentMap: UnknownRecord,
    baselineMap: unknown | null,
): BindingHistoryComparison {
    if (baselineMap === null) {
        return { checkedBindings: 0, initialIntroduction: true };
    }

    const errors: string[] = [];
    if (!validateBaselineMapShape(baselineMap, errors)) {
        throw new RegistryValidationError(errors);
    }
    const currentQiitaUser = currentMap.qiita_user as string;
    const currentBindings = currentMap.bindings as Record<string, ArticleMapBinding>;
    if (currentQiitaUser !== baselineMap.qiita_user) {
        errors.push(
            `article-map.qiita_user の変更は禁止されています: `
            + `${baselineMap.qiita_user} -> ${currentQiitaUser}`,
        );
    }

    for (const [articleId, oldBinding] of Object.entries(baselineMap.bindings)) {
        const currentBinding = currentBindings[articleId];
        if (!currentBinding) {
            errors.push(
                `既存 binding の削除は禁止されています: ${articleId} -> ${oldBinding.item_id}`,
            );
            continue;
        }
        if (currentBinding.item_id !== oldBinding.item_id) {
            errors.push(
                `既存 binding の item_id 変更は禁止されています: ${articleId} `
                + `${oldBinding.item_id} -> ${currentBinding.item_id}`,
            );
        }
    }

    if (errors.length > 0) {
        throw new RegistryValidationError(errors);
    }
    return {
        checkedBindings: Object.keys(baselineMap.bindings).length,
        initialIntroduction: false,
    };
}

function validateBindingHistory(
    options: ValidateBindingHistoryOptions = {},
): BindingHistoryResult {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const context = loadPublicationContext({ rootDir, requirePublicTargets: false });
    const baselineRef = options.baselineRef || 'HEAD^';
    const baselineMap = Object.hasOwn(options, 'baselineMap')
        ? options.baselineMap
        : loadBaselineMapFromGit({
            rootDir,
            baselineRef,
            gitRunner: options.gitRunner,
        });
    return {
        context,
        baselineRef,
        ...compareBindingHistory(context.articleMap, baselineMap),
    };
}

function parseCliArgs(args: string[]): { baselineRef: string } {
    const optionIndex = args.indexOf('--baseline-ref');
    if (optionIndex === -1) {
        return { baselineRef: 'HEAD^' };
    }
    const baselineRef = args[optionIndex + 1];
    if (!baselineRef || baselineRef.startsWith('--')) {
        throw new Error('--baseline-ref には Git commit/ref が必要です');
    }
    if (args.length !== 2 || optionIndex !== 0) {
        throw new Error('使用方法: node scripts/validate-map-history.ts [--baseline-ref <ref>]');
    }
    return { baselineRef };
}

export interface ValidateMapHistoryExports {
    compareBindingHistory: typeof compareBindingHistory;
    loadBaselineMapFromGit: typeof loadBaselineMapFromGit;
    validateBindingHistory: typeof validateBindingHistory;
}

module.exports = {
    compareBindingHistory,
    loadBaselineMapFromGit,
    validateBindingHistory,
};

if (require.main === module) {
    try {
        const result = validateBindingHistory(parseCliArgs(process.argv.slice(2)));
        if (result.initialIntroduction) {
            console.log(
                `No article-map.json exists at ${result.baselineRef}; `
                + 'initial map introduction is allowed.',
            );
        } else {
            console.log(
                `Validated ${result.checkedBindings} immutable Qiita bindings `
                + `against ${result.baselineRef}.`,
            );
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

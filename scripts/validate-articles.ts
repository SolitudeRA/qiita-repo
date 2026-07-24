import type {
    ArticleRegistryExports,
    PublicationContextWithTargets,
    RootDirOptions,
} from './lib/article-registry.ts';

const path: typeof import('node:path') = require('node:path');
const {
    loadPublicationContext,
} = require('./lib/article-registry.ts') as ArticleRegistryExports;

function validateArticles(options: RootDirOptions = {}): PublicationContextWithTargets {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    return loadPublicationContext({ rootDir, requirePublicTargets: true });
}

export interface ValidateArticlesExports {
    validateArticles: typeof validateArticles;
}

module.exports = {
    validateArticles,
};

if (require.main === module) {
    try {
        const context = validateArticles();
        console.log(
            `Validated ${context.articles.length} active/published Qiita article bindings.`,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

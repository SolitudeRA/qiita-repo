import type { GenerateSeriesLinksExports } from './generate-series-links.ts';
import type { RootDirOptions } from './lib/article-registry.ts';
import type { ParseArticlesExports } from './parse-articles.ts';

const {
    writePublicArticles,
} = require('./parse-articles.ts') as ParseArticlesExports;
const {
    writeSeriesLinks,
} = require('./generate-series-links.ts') as GenerateSeriesLinksExports;

export interface BuildArticlesResult {
    parsed: number;
    linked: number;
}

function buildArticles(options: RootDirOptions = {}): BuildArticlesResult {
    const parsed = writePublicArticles(options);
    const linked = writeSeriesLinks(options);
    return {
        parsed: parsed.writes.length,
        linked: linked.writes.length,
    };
}

export interface BuildArticlesExports {
    buildArticles: typeof buildArticles;
}

module.exports = {
    buildArticles,
};

if (require.main === module) {
    try {
        const result = buildArticles();
        console.log(
            `Built ${result.parsed} ID-bound articles and generated `
            + `${result.linked} link sets.`,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

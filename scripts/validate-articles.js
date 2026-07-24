const path = require('node:path');
const { loadPublicationContext } = require('./lib/article-registry');

function validateArticles(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    return loadPublicationContext({ rootDir, requirePublicTargets: true });
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
        console.error(error.message);
        process.exitCode = 1;
    }
}

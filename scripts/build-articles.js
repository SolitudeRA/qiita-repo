const { writePublicArticles } = require('./parse-articles');
const { writeSeriesLinks } = require('./generate-series-links');

function buildArticles(options = {}) {
    const parsed = writePublicArticles(options);
    const linked = writeSeriesLinks(options);
    return {
        parsed: parsed.writes.length,
        linked: linked.writes.length,
    };
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
        console.error(error.message);
        process.exitCode = 1;
    }
}

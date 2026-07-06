const path = require('path');

module.exports = {
    mode: 'production',
    entry: {
        // background: './background.js',
        content: './scripts/inject.js',
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, './out')
    }
};
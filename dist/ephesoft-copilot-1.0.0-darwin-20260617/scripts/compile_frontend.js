const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'electron', 'renderer', 'app.jsx');
const destPath = path.join(__dirname, '..', 'electron', 'renderer', 'app.js');

console.log('Compiling app.jsx to app.js...');
try {
    const result = babel.transformFileSync(srcPath, {
        presets: ['@babel/preset-react'],
        compact: false,
        comments: true
    });
    fs.writeFileSync(destPath, result.code);
    console.log('✓ Compilation successful!');
} catch (e) {
    console.error('✗ Compilation failed:', e);
    process.exit(1);
}

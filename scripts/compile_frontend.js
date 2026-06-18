const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'electron', 'renderer', 'app.jsx');
const destPath = path.join(__dirname, '..', 'electron', 'renderer', 'app.js');

console.log('Compiling app.jsx to app.js...');
try {
    // 'classic' runtime emits React.createElement(...) which works with the
    // UMD React global loaded via <script>. The default 'automatic' runtime
    // emits `import {jsx} from "react/jsx-runtime"`, which breaks in a plain
    // <script> tag (no bundler/ESM) — that was the blank-panel cause.
    const result = babel.transformFileSync(srcPath, {
        presets: [['@babel/preset-react', { runtime: 'classic' }]],
        compact: false,
        comments: true
    });
    fs.writeFileSync(destPath, result.code);
    console.log('✓ Compilation successful!');
} catch (e) {
    console.error('✗ Compilation failed:', e);
    process.exit(1);
}

'use strict';

/* The checklist and the verification engine have exactly one canonical source,
   in /shared, which the website serves directly to the browser. The Lambda
   bundle cannot reach outside its own directory, so copy them in before any
   build, run or deploy. Never edit the copies. */

const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', '..', 'shared');
const to = path.join(__dirname, '..', 'src', 'verification');

fs.mkdirSync(to, { recursive: true });

for (const file of ['checklist.js', 'verify.js']) {
    const source = fs.readFileSync(path.join(from, file), 'utf8');
    fs.writeFileSync(
        path.join(to, file),
        `/* GENERATED COPY of /shared/${file} — edit the original, then run npm run sync-shared. */\n` + source
    );
    console.log(`synced shared/${file}`);
}

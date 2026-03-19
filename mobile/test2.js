const fs = require('fs-extra');
(async () => {
    try {
        await fs.ensureFile('sample/1.txt');
        console.log("made");
    } catch(e) { console.error(e) }
})()

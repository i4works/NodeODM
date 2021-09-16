const fs = require('fs');
const { spawn } = require('child_process');

const childProcess = spawn('pdal', ['info', '--summary', process.argv[2]]);

function execute() {
    let stdout = '';
    let stderr = '';

    childProcess
        .on('exit', (code, signal) => {
            if (signal) {
                return console.error(`terminated with signal:${signal}`);
            }

            // write coord into metadata.json
            const proj4 = JSON.parse(stdout).summary.srs.proj4;

            fs.readFile(process.argv[3], 'utf8', (err, data) => {
                if (err) return console.error(err);

                const result = data.replace(`"projection": ""`, `"projection": "${proj4}"`);

                fs.writeFile(process.argv[3], result, 'utf8', err => {
                    if (err) return console.error(err);

                    console.log(`completed with code ${code}`);
                });
            });

        })
        .on('error', (err) => {
            return console.error(err);
        });

    childProcess.stdout.on('data', data => { stdout += data });
    childProcess.stderr.on('data', data => { stderr += data });
}

execute();
